from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import schemas
from app.config import get_settings
from app.db import get_db
from app.llm.gateway import LLMGateway, get_gateway
from app.models import LLMCall, Project, RawInput, Requirement
from app.rules import appeals_keys, load_appeals
from app.services.extraction import extract_requirements

router = APIRouter(prefix="/api")


def _get_or_404(db: Session, model: type, obj_id: int, label: str) -> Any:
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"{label}不存在")
    return obj


@router.get("/health", response_model=schemas.HealthOut)
def health() -> schemas.HealthOut:
    settings = get_settings()
    demo = settings.llm_provider == "mock"
    return schemas.HealthOut(
        status="ok",
        llm_provider=settings.llm_provider,
        llm_model="" if demo else settings.llm_model,
        demo_mode=demo,
    )


@router.get("/rules/appeals")
def get_appeals_rules() -> dict[str, Any]:
    return load_appeals()


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
        content=body.content,
    )
    db.add(raw_input)
    db.commit()
    requirements = extract_requirements(db, gateway, raw_input)
    return schemas.ExtractionResult(
        input=schemas.RawInputOut.model_validate(raw_input),
        requirements=[schemas.RequirementOut.model_validate(r) for r in requirements],
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
        requirements=[schemas.RequirementOut.model_validate(r) for r in requirements],
    )


# ---- 需求 ----


@router.get("/projects/{project_id}/requirements", response_model=list[schemas.RequirementOut])
def list_requirements(
    project_id: int,
    status: schemas.RequirementStatus | None = None,
    db: Session = Depends(get_db),
) -> list[Requirement]:
    _get_or_404(db, Project, project_id, "项目")
    query = select(Requirement).where(Requirement.project_id == project_id)
    if status:
        query = query.where(Requirement.status == status)
    return list(db.scalars(query.order_by(Requirement.id.desc())))


@router.patch("/requirements/{requirement_id}", response_model=schemas.RequirementOut)
def update_requirement(
    requirement_id: int, body: schemas.RequirementUpdate, db: Session = Depends(get_db)
) -> Requirement:
    requirement: Requirement = _get_or_404(db, Requirement, requirement_id, "需求")
    changes = body.model_dump(exclude_unset=True)
    if "appeals" in changes and changes["appeals"] is not None and changes["appeals"] not in appeals_keys():
        raise HTTPException(status_code=422, detail="不认识的 $APPEALS 维度")
    for field in ("title", "description", "priority", "status"):
        if field in changes and changes[field] is None:
            raise HTTPException(status_code=422, detail=f"{field} 不能为空")
    for field, value in changes.items():
        setattr(requirement, field, value.strip() if field == "title" else value)
    db.commit()
    db.refresh(requirement)
    return requirement


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
