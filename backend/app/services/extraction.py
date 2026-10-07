"""从原始材料中提取客户诉求，并分析每条诉求背后的真实需求。

目标不是照单全收地记录客户的话，而是从客户的表达出发，找到他真正要解决的问题。
同时必须防止另一个方向的错误：脱离材料自行想象。所以每条推断都要带依据、
推理过程、把握程度和待追问的问题，由人来判断推得对不对。
"""

import json
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm.gateway import LLMGateway
from app.llm.providers import LLMError
from app.models import Project, RawInput, Requirement
from app.rules import (
    appeals_keys,
    category_keys,
    disposition_keys,
    load_appeals,
    load_classification,
    load_prompts,
    priority_keys,
    subcategory_keys,
)
from app.services.parsing import (
    ModelOutputError,
    choice,
    get_list,
    known_id,
    load_json_object,
    normalize,
    text_list,
    text_of,
)

TASK = "extract_requirements"
_PROMPT = load_prompts()["extract_requirements"]
PROMPT_VERSION: str = _PROMPT["version"]

# 去重时提供给模型参考的已有需求数量上限。
MAX_EXISTING = 200

CONFIDENCE_LEVELS = {"high", "medium", "low"}
DEMAND_TYPES = {"strategic", "project", "unknown"}

SYSTEM_PROMPT: str = _PROMPT["system"].strip()

# 保留旧名字，调用方按“提取失败”来理解即可。
ExtractionError = ModelOutputError


def classification_block() -> str:
    rules = load_classification()
    quality = "\n".join(
        f"  - {q['key']}（{q['name']}）：{q['description']}" for q in rules["quality_attributes"]
    )
    constraints = "\n".join(f"  - {c['key']}（{c['name']}）" for c in rules["constraints"])
    dispositions = "\n".join(
        f"- {d['key']}（{d['name']}）：{d['description']}" for d in rules["dispositions"]
    )
    return (
        f"<分类>\n质量属性：\n{quality}\n设计约束：\n{constraints}\n</分类>\n\n"
        f"<去向>\n{dispositions}\n</去向>\n\n"
    )


def background_block(background: str) -> str:
    return f"<项目背景>\n{background.strip() or '（未填写）'}\n</项目背景>\n\n"


def build_user_prompt(
    raw_input: RawInput, existing: list[dict[str, Any]], background: str = ""
) -> str:
    dims = "\n".join(
        f"- {d['key']}（{d['name']}）：{d['description']}" for d in load_appeals()["dimensions"]
    )
    source = re.sub(r'[<>"\n]', "", raw_input.source_type) or "未注明"
    requester = re.sub(r'[<>"\n]', "", raw_input.requester) or "未注明"
    return (
        background_block(background)
        + classification_block()
        + f"<维度>\n{dims}\n</维度>\n\n"
        f"<已有需求>\n{json.dumps(existing, ensure_ascii=False)}\n</已有需求>\n\n"
        f"<材料 来源=\"{source}\" 提出者=\"{requester}\">\n{raw_input.content}\n</材料>"
    )


def parse_extraction(text: str, *, content: str, existing_ids: set[int]) -> list[dict[str, Any]]:
    """把模型输出解析成可以入库的字段。"""
    items = get_list(load_json_object(text), "requirements")
    normalized_content = normalize(content)
    results: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = text_of(item, "title")
        if not title:
            continue
        category = choice(item.get("category"), category_keys(), "unknown")
        quote = text_of(item, "source_quote")
        normalized_quote = normalize(quote)
        results.append(
            {
                "kind": "stated",
                "title": title[:300],
                "description": text_of(item, "description"),
                "stated_request": text_of(item, "stated_request"),
                "underlying_problem": text_of(item, "underlying_problem"),
                "reasoning": text_of(item, "reasoning"),
                # 模型没有给出合法的把握程度时按最低处理，宁可多核对。
                "confidence": choice(item.get("confidence"), CONFIDENCE_LEVELS, "low"),
                "demand_type": choice(item.get("demand_type"), DEMAND_TYPES, "unknown"),
                "category": category,
                # 子类必须属于所选类别，否则丢弃子类，保留类别。
                "subcategory": choice(item.get("subcategory"), subcategory_keys(category), None),
                "disposition": choice(item.get("disposition"), disposition_keys(), "undecided"),
                "disposition_reason": text_of(item, "disposition_reason"),
                "open_questions": text_list(item.get("open_questions")),
                "source_quote": quote,
                # 依据必须能在原始材料里逐字找到，否则标记为未核实，由界面提示用户。
                "quote_verified": bool(normalized_quote) and normalized_quote in normalized_content,
                "appeals": choice(item.get("appeals"), appeals_keys(), None),
                "priority": choice(item.get("priority"), priority_keys(), "medium"),
                "priority_reason": text_of(item, "priority_reason"),
                "duplicate_of_id": known_id(item.get("duplicate_of"), existing_ids),
            }
        )
    return results


def extract_requirements(db: Session, gateway: LLMGateway, raw_input: RawInput) -> list[Requirement]:
    """对一份原始材料运行提取。失败时把材料标记为 failed 并返回空列表，可以重试。"""
    rows = db.execute(
        select(Requirement.id, Requirement.title)
        .where(
            Requirement.project_id == raw_input.project_id,
            Requirement.status.notin_(["rejected", "merged"]),
        )
        .order_by(Requirement.id.desc())
        .limit(MAX_EXISTING)
    ).all()
    existing = [{"id": r.id, "title": r.title} for r in rows]
    project = db.get(Project, raw_input.project_id)
    background = project.description if project else ""

    try:
        text = gateway.complete(
            db,
            task=TASK,
            prompt_version=PROMPT_VERSION,
            system=SYSTEM_PROMPT,
            user=build_user_prompt(raw_input, existing, background),
            project_id=raw_input.project_id,
            input_id=raw_input.id,
        )
        parsed = parse_extraction(
            text, content=raw_input.content, existing_ids={e["id"] for e in existing}
        )
    except (LLMError, ModelOutputError) as exc:
        raw_input.status = "failed"
        raw_input.error = str(exc)
        db.commit()
        return []

    requirements = [
        Requirement(
            project_id=raw_input.project_id,
            input_id=raw_input.id,
            created_by=raw_input.created_by,
            **fields,
        )
        for fields in parsed
    ]
    db.add_all(requirements)
    raw_input.status = "processed"
    raw_input.error = None
    db.commit()
    return requirements
