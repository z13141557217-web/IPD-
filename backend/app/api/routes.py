import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import schemas
from app.config import get_settings
from app.db import get_db
from app.llm.gateway import LLMGateway, build_provider, get_gateway
from app.models import LLMCall, Project, RawInput, Requirement
from app.rules import appeals_keys, load_appeals, load_classification, subcategory_keys
from app.llm.providers import LLMError
from app.services.extraction import extract_requirements
from app.services.latent import NotEnoughRequirements, discover_latent_needs
from app.services.parsing import ModelOutputError
from app.services.sample import create_sample_project
from app.services.settings import LLMConfig, get_llm_config, key_hint, save_llm_config
from app.version import __version__

router = APIRouter(prefix="/api")


def _get_or_404(db: Session, model: type, obj_id: int, label: str) -> Any:
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"{label}不存在")
    return obj


@router.get("/health", response_model=schemas.HealthOut)
def health(db: Session = Depends(get_db)) -> schemas.HealthOut:
    config = get_llm_config(db)
    demo = config.provider == "mock"
    return schemas.HealthOut(
        version=__version__,
        status="ok",
        llm_provider=config.provider,
        llm_model="" if demo else config.model,
        demo_mode=demo,
    )


# ---- 设置 ----


def _llm_settings_out(config: LLMConfig) -> schemas.LLMSettingsOut:
    return schemas.LLMSettingsOut(
        provider=config.provider,
        base_url=config.base_url,
        model=config.model,
        api_key_set=bool(config.api_key),
        api_key_hint=key_hint(config.api_key),
        source=config.source,
    )


@router.get("/settings", response_model=schemas.SettingsOut)
def get_app_settings(db: Session = Depends(get_db)) -> schemas.SettingsOut:
    return schemas.SettingsOut(version=__version__, llm=_llm_settings_out(get_llm_config(db)))


@router.put("/settings/llm", response_model=schemas.LLMSettingsOut)
def update_llm_settings(
    body: schemas.LLMSettingsUpdate, db: Session = Depends(get_db)
) -> schemas.LLMSettingsOut:
    if body.provider == "openai_compatible":
        if not body.base_url.strip().lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=422, detail="接口地址要以 http:// 或 https:// 开头")
        if not body.model.strip():
            raise HTTPException(status_code=422, detail="请填写模型名称")
    config = save_llm_config(
        db, provider=body.provider, base_url=body.base_url, model=body.model, api_key=body.api_key
    )
    return _llm_settings_out(config)


@router.post("/settings/llm/test", response_model=schemas.LLMTestResult)
def test_llm_settings(db: Session = Depends(get_db)) -> schemas.LLMTestResult:
    """用当前保存的配置向模型发一句话，确认地址、密钥和模型名称都对。"""
    config = get_llm_config(db)
    if config.provider == "mock":
        return schemas.LLMTestResult(ok=True, latency_ms=0, message="演示模式不调用模型，无需测试。")
    started = time.monotonic()
    try:
        reply = build_provider(config).complete("你在做连通性测试。", "请只回复两个字：正常")
    except LLMError as exc:
        return schemas.LLMTestResult(
            ok=False, latency_ms=int((time.monotonic() - started) * 1000), message=str(exc)
        )
    return schemas.LLMTestResult(
        ok=True,
        latency_ms=int((time.monotonic() - started) * 1000),
        message=f"连接成功，模型回复：{reply.strip()[:50]}",
    )


@router.get("/rules/appeals")
def get_appeals_rules() -> dict[str, Any]:
    return load_appeals()


@router.get("/rules/classification")
def get_classification_rules() -> dict[str, Any]:
    return load_classification()


def _serialize(db: Session, requirements: list[Requirement]) -> list[schemas.RequirementOut]:
    """转成接口输出，并补上“几处提到、来自谁”。

    一条需求被提到的次数 = 它自己 + 并入它的需求数；提出者取自这些需求所属材料。
    """
    if not requirements:
        return []
    project_ids = {r.project_id for r in requirements}
    merged = db.execute(
        select(Requirement.duplicate_of_id, Requirement.input_id).where(
            Requirement.project_id.in_(project_ids), Requirement.status == "merged"
        )
    ).all()
    requester_of = dict(
        db.execute(
            select(RawInput.id, RawInput.requester).where(RawInput.project_id.in_(project_ids))
        ).all()
    )
    merged_inputs: dict[int, list[int | None]] = {}
    for target_id, input_id in merged:
        if target_id is not None:
            merged_inputs.setdefault(target_id, []).append(input_id)

    result = []
    for r in requirements:
        out = schemas.RequirementOut.model_validate(r)
        extra = merged_inputs.get(r.id, [])
        out.mention_count = 1 + len(extra)
        names = {requester_of.get(i, "") for i in [r.input_id, *extra] if i is not None}
        out.requesters = sorted(n for n in names if n)
        result.append(out)
    return result


# ---- 项目 ----


@router.get("/projects", response_model=list[schemas.ProjectOut])
def list_projects(db: Session = Depends(get_db)) -> list[Project]:
    return list(db.scalars(select(Project).order_by(Project.id.desc())))


@router.post("/projects", response_model=schemas.ProjectOut, status_code=201)
def create_project(body: schemas.ProjectCreate, db: Session = Depends(get_db)) -> Project:
    project = Project(
        name=body.name.strip(), description=body.description, owner=get_settings().default_user
    )
    db.add(project)
    db.commit()
    return project


@router.post("/projects/sample", response_model=schemas.ProjectOut, status_code=201)
def create_sample_project_route(db: Session = Depends(get_db)) -> Project:
    """载入演示项目：一套预置的材料和需求。之后的操作和普通项目完全一样。"""
    project = create_sample_project(db, owner=get_settings().default_user)
    db.commit()
    return project


@router.patch("/projects/{project_id}", response_model=schemas.ProjectOut)
def update_project(
    project_id: int, body: schemas.ProjectUpdate, db: Session = Depends(get_db)
) -> Project:
    project: Project = _get_or_404(db, Project, project_id, "项目")
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if value is None:
            raise HTTPException(status_code=422, detail=f"{field} 不能为空")
        setattr(project, field, value.strip() if isinstance(value, str) else value)
    if not project.name:
        raise HTTPException(status_code=422, detail="项目名称不能为空")
    db.commit()
    db.refresh(project)
    return project


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db)) -> None:
    """删除项目，连同它的材料、需求和模型调用记录。无法恢复。"""
    project: Project = _get_or_404(db, Project, project_id, "项目")
    # 逐张表显式删除，不依赖数据库的级联设置，在任何数据库上行为都一样。
    db.execute(delete(Requirement).where(Requirement.project_id == project_id))
    db.execute(delete(RawInput).where(RawInput.project_id == project_id))
    db.execute(delete(LLMCall).where(LLMCall.project_id == project_id))
    db.delete(project)
    db.commit()


# ---- 原始材料与提取 ----


@router.get("/projects/{project_id}/inputs", response_model=list[schemas.RawInputOut])
def list_inputs(project_id: int, db: Session = Depends(get_db)) -> list[RawInput]:
    _get_or_404(db, Project, project_id, "项目")
    return list(
        db.scalars(
            select(RawInput).where(RawInput.project_id == project_id).order_by(RawInput.id.desc())
        )
    )


@router.post(
    "/projects/{project_id}/inputs", response_model=schemas.ExtractionResult, status_code=201
)
def submit_input(
    project_id: int,
    body: schemas.RawInputCreate,
    db: Session = Depends(get_db),
    gateway: LLMGateway = Depends(get_gateway),
) -> schemas.ExtractionResult:
    """保存一份原始材料并立即提取需求。

    提取失败不会丢失材料：返回的 input.status 为 failed，error 说明原因，可调用重试接口。
    """
    _get_or_404(db, Project, project_id, "项目")
    if not body.content.strip():
        raise HTTPException(status_code=422, detail="材料内容不能为空")
    raw_input = RawInput(
        project_id=project_id,
        created_by=get_settings().default_user,
        source_type=body.source_type.strip(),
        requester=body.requester.strip(),
        content=body.content,
    )
    db.add(raw_input)
    db.commit()
    requirements = extract_requirements(db, gateway, raw_input)
    return schemas.ExtractionResult(
        input=schemas.RawInputOut.model_validate(raw_input),
        requirements=_serialize(db, requirements),
    )


@router.post("/inputs/{input_id}/extract", response_model=schemas.ExtractionResult)
def retry_extraction(
    input_id: int,
    db: Session = Depends(get_db),
    gateway: LLMGateway = Depends(get_gateway),
) -> schemas.ExtractionResult:
    raw_input: RawInput = _get_or_404(db, RawInput, input_id, "材料")
    if raw_input.status == "processed":
        raise HTTPException(status_code=409, detail="这份材料已经提取过，重复提取会产生重复需求")
    requirements = extract_requirements(db, gateway, raw_input)
    return schemas.ExtractionResult(
        input=schemas.RawInputOut.model_validate(raw_input),
        requirements=_serialize(db, requirements),
    )


# ---- 需求 ----


@router.get("/projects/{project_id}/requirements", response_model=list[schemas.RequirementOut])
def list_requirements(
    project_id: int,
    status: schemas.RequirementStatusFilter | None = None,
    db: Session = Depends(get_db),
) -> list[schemas.RequirementOut]:
    _get_or_404(db, Project, project_id, "项目")
    query = select(Requirement).where(Requirement.project_id == project_id)
    if status:
        query = query.where(Requirement.status == status)
    return _serialize(db, list(db.scalars(query.order_by(Requirement.id.desc()))))


@router.patch("/requirements/{requirement_id}", response_model=schemas.RequirementOut)
def update_requirement(
    requirement_id: int, body: schemas.RequirementUpdate, db: Session = Depends(get_db)
) -> schemas.RequirementOut:
    requirement: Requirement = _get_or_404(db, Requirement, requirement_id, "需求")
    changes = body.model_dump(exclude_unset=True)
    if "appeals" in changes and changes["appeals"] is not None and changes["appeals"] not in appeals_keys():
        raise HTTPException(status_code=422, detail="不认识的 $APPEALS 维度")
    for field in changes:
        if field not in ("appeals", "subcategory") and changes[field] is None:
            raise HTTPException(status_code=422, detail=f"{field} 不能为空")
    if "open_questions" in changes:
        changes["open_questions"] = [q.strip() for q in changes["open_questions"] if q.strip()]
    for field, value in changes.items():
        setattr(requirement, field, value.strip() if field == "title" else value)
    # 类别变了而子类没跟着传时，原来的子类不再适用。
    if requirement.subcategory not in subcategory_keys(requirement.category):
        if "subcategory" in changes and changes["subcategory"] is not None:
            db.rollback()
            raise HTTPException(status_code=422, detail="这个子类不属于所选的需求类别")
        requirement.subcategory = None
    # 确认过的需求必须有去向，否则确认之后就没有下文了。
    if (
        requirement.status == "confirmed"
        and requirement.disposition == "undecided"
        and ("status" in changes or "disposition" in changes)
    ):
        db.rollback()
        raise HTTPException(status_code=422, detail="确认前请先选定这条需求的去向")
    # 潜在需求是假设。没有向客户验证成立之前不能当作正式需求，否则就成了自己想当然。
    if (
        requirement.kind == "latent"
        and requirement.status == "confirmed"
        and requirement.validation_status != "validated"
    ):
        db.rollback()
        raise HTTPException(status_code=422, detail="潜在需求必须先向客户验证成立，才能确认")
    db.commit()
    db.refresh(requirement)
    return _serialize(db, [requirement])[0]


@router.post("/requirements/{requirement_id}/merge", response_model=schemas.MergeResult)
def merge_requirement(
    requirement_id: int, body: schemas.MergeRequest, db: Session = Depends(get_db)
) -> schemas.MergeResult:
    """把一条需求并入另一条实质相同的需求。

    被并入的需求不会消失：它的原话和提出者会算作目标需求的又一处依据。
    """
    source: Requirement = _get_or_404(db, Requirement, requirement_id, "需求")
    target: Requirement = _get_or_404(db, Requirement, body.target_id, "要并入的需求")
    if source.id == target.id:
        raise HTTPException(status_code=422, detail="不能并入自己")
    if source.project_id != target.project_id:
        raise HTTPException(status_code=422, detail="只能并入同一个项目里的需求")
    if source.kind != "stated" or target.kind != "stated":
        raise HTTPException(status_code=422, detail="只有客户提出的需求可以合并")
    if source.status == "merged":
        raise HTTPException(status_code=409, detail="这条需求已经并入别的需求")
    if target.status in ("merged", "rejected"):
        raise HTTPException(status_code=409, detail="目标需求已被合并或否决，不能再并入")

    # 之前并入这条需求的，一起转到新的目标上，保持只有一层。
    for child in db.scalars(
        select(Requirement).where(
            Requirement.duplicate_of_id == source.id, Requirement.status == "merged"
        )
    ):
        child.duplicate_of_id = target.id
    source.status = "merged"
    source.duplicate_of_id = target.id
    db.commit()
    merged_out, target_out = _serialize(db, [source, target])
    return schemas.MergeResult(merged=merged_out, target=target_out)


@router.post("/projects/{project_id}/latent-needs", response_model=schemas.LatentNeedsResult)
def discover_latent(
    project_id: int,
    db: Session = Depends(get_db),
    gateway: LLMGateway = Depends(get_gateway),
) -> schemas.LatentNeedsResult:
    """基于项目中已有的客户需求，提出客户没有明说的潜在需求假设。"""
    _get_or_404(db, Project, project_id, "项目")
    try:
        result = discover_latent_needs(db, gateway, project_id, get_settings().default_user)
    except NotEnoughRequirements as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (LLMError, ModelOutputError) as exc:
        raise HTTPException(status_code=502, detail=f"分析失败：{exc}") from exc
    return schemas.LatentNeedsResult(
        requirements=_serialize(db, result.requirements),
        dropped_without_basis=result.dropped_without_basis,
    )


# ---- 模型调用记录 ----


@router.get("/projects/{project_id}/llm-calls", response_model=list[schemas.LLMCallOut])
def list_llm_calls(
    project_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[LLMCall]:
    _get_or_404(db, Project, project_id, "项目")
    return list(
        db.scalars(
            select(LLMCall)
            .where(LLMCall.project_id == project_id)
            .order_by(LLMCall.id.desc())
            .limit(limit)
        )
    )
