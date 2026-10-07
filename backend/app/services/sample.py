"""演示项目：把 rules/sample_project.yaml 里的示例内容写进数据库，成为一个普通项目。"""

from sqlalchemy.orm import Session

from app.models import Project, RawInput, Requirement
from app.rules import load_sample_project

# 示例里可以直接写的需求字段。其余字段（编号、所属项目、互相引用）在载入时填。
_PLAIN_FIELDS = (
    "title",
    "description",
    "source_quote",
    "stated_request",
    "underlying_problem",
    "reasoning",
    "confidence",
    "open_questions",
    "demand_type",
    "category",
    "subcategory",
    "disposition",
    "disposition_reason",
    "appeals",
    "priority",
    "priority_reason",
    "kind",
    "validation_plan",
    "status",
    "reject_reason",
)


def create_sample_project(db: Session, *, owner: str) -> Project:
    """写入演示项目，返回它。调用方负责提交。"""
    sample = load_sample_project()

    project = Project(
        name=sample["project"]["name"],
        description=sample["project"]["description"],
        owner=owner,
        is_sample=True,
    )
    db.add(project)
    db.flush()

    inputs: dict[str, RawInput] = {}
    for item in sample["inputs"]:
        raw = RawInput(
            project_id=project.id,
            created_by=owner,
            source_type=item["source_type"],
            requester=item["requester"],
            content=item["content"],
            status="processed",
        )
        db.add(raw)
        inputs[item["ref"]] = raw
    db.flush()

    # 先全部写入拿到真实编号，再把互相之间的引用换成真实编号。
    created: dict[int, Requirement] = {}
    for item in sample["requirements"]:
        raw = inputs.get(item.get("input", ""))
        requirement = Requirement(
            project_id=project.id,
            created_by=owner,
            input_id=raw.id if raw else None,
            # 示例里的原文都摘自对应的材料，这里仍然实际核对一遍，而不是直接写成“已核对”。
            quote_verified=bool(raw and item.get("source_quote") and item["source_quote"] in raw.content),
            **{field: item[field] for field in _PLAIN_FIELDS if field in item},
        )
        db.add(requirement)
        db.flush()
        created[item["ref"]] = requirement

    for item in sample["requirements"]:
        requirement = created[item["ref"]]
        requirement.based_on = [created[ref].id for ref in item.get("based_on", [])]
        if "duplicate_of" in item:
            requirement.duplicate_of_id = created[item["duplicate_of"]].id
    db.flush()
    return project
