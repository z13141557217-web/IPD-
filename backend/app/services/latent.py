"""从已有需求中发现客户没有明说的潜在需求。

潜在需求和“自己觉得客户需要”的区别只有一个：客户是否真的需要。这一点模型判断不了，
只有拿去向客户验证才知道。所以这里产出的一律是待验证的假设，并且设了两道关：
1. 每条假设必须指明依据的是哪些已有需求，没有依据的直接丢弃；
2. 假设在验证成立之前不能被确认为正式需求（在接口层强制）。
"""

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm.gateway import LLMGateway
from app.models import Project, Requirement
from app.rules import appeals_keys, load_appeals, load_prompts, priority_keys
from app.services.parsing import (
    choice,
    get_list,
    known_id,
    load_json_object,
    text_list,
    text_of,
)

TASK = "discover_latent_needs"
_PROMPT = load_prompts()["discover_latent_needs"]
PROMPT_VERSION: str = _PROMPT["version"]

# 需求太少时看不出共性，不值得调用模型。
MIN_REQUIREMENTS = 3
MAX_REQUIREMENTS = 200
MAX_HYPOTHESES = 5

SYSTEM_PROMPT: str = (
    _PROMPT["system"].strip().replace("{max_hypotheses}", str(MAX_HYPOTHESES))
)


class NotEnoughRequirements(Exception):
    pass


@dataclass
class LatentResult:
    requirements: list[Requirement]
    # 因为没有给出有效依据而被丢弃的假设数量。
    dropped_without_basis: int


def build_user_prompt(
    stated: list[Requirement], existing_latent: list[str], background: str = ""
) -> str:
    dims = "\n".join(
        f"- {d['key']}（{d['name']}）：{d['description']}" for d in load_appeals()["dimensions"]
    )
    items = [
        {
            "id": r.id,
            "title": r.title,
            "stated_request": r.stated_request,
            "underlying_problem": r.underlying_problem,
            "source_quote": r.source_quote,
        }
        for r in stated
    ]
    return (
        f"<项目背景>\n{background.strip() or '（未填写）'}\n</项目背景>\n\n"
        f"<维度>\n{dims}\n</维度>\n\n"
        f"<已有假设>\n{json.dumps(existing_latent, ensure_ascii=False)}\n</已有假设>\n\n"
        f"<需求清单>\n{json.dumps(items, ensure_ascii=False)}\n</需求清单>"
    )


def parse_hypotheses(text: str, *, known_ids: set[int]) -> tuple[list[dict[str, Any]], int]:
    """返回（可入库的假设，因没有有效依据被丢弃的数量）。"""
    items = get_list(load_json_object(text), "hypotheses")
    results: list[dict[str, Any]] = []
    dropped = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        title = text_of(item, "title")
        if not title:
            continue
        raw_basis = item.get("based_on")
        basis: list[int] = []
        for value in raw_basis if isinstance(raw_basis, list) else []:
            rid = known_id(value, known_ids)
            if rid is not None and rid not in basis:
                basis.append(rid)
        if not basis:
            # 没有指向任何真实存在的需求，就是没有依据的想象，不入库。
            dropped += 1
            continue
        results.append(
            {
                "kind": "latent",
                "title": title[:300],
                "description": text_of(item, "description"),
                "based_on": basis,
                "reasoning": text_of(item, "reasoning"),
                "validation_plan": text_of(item, "validation_plan"),
                "open_questions": text_list(item.get("open_questions")),
                "validation_status": "unverified",
                "confidence": "low",
                "appeals": choice(item.get("appeals"), appeals_keys(), None),
                "priority": choice(item.get("priority"), priority_keys(), "medium"),
                "priority_reason": text_of(item, "priority_reason"),
            }
        )
        if len(results) >= MAX_HYPOTHESES:
            break
    return results, dropped


def discover_latent_needs(
    db: Session, gateway: LLMGateway, project_id: int, created_by: str
) -> LatentResult:
    """可能抛出 NotEnoughRequirements、LLMError、ModelOutputError，由接口层转成提示。"""
    active = list(
        db.scalars(
            select(Requirement)
            .where(
                Requirement.project_id == project_id,
                Requirement.status.notin_(["rejected", "merged"]),
            )
            .order_by(Requirement.id.desc())
            .limit(MAX_REQUIREMENTS)
        )
    )
    stated = [r for r in active if r.kind == "stated"]
    if len(stated) < MIN_REQUIREMENTS:
        raise NotEnoughRequirements(
            f"至少需要 {MIN_REQUIREMENTS} 条未否决的客户需求才能分析潜在需求，目前只有 {len(stated)} 条。"
        )
    existing_latent = [r.title for r in active if r.kind == "latent"]
    project = db.get(Project, project_id)
    background = project.description if project else ""

    text = gateway.complete(
        db,
        task=TASK,
        prompt_version=PROMPT_VERSION,
        system=SYSTEM_PROMPT,
        user=build_user_prompt(stated, existing_latent, background),
        project_id=project_id,
    )
    parsed, dropped = parse_hypotheses(text, known_ids={r.id for r in stated})

    requirements = [
        Requirement(project_id=project_id, created_by=created_by, **fields) for fields in parsed
    ]
    db.add_all(requirements)
    db.commit()
    return LatentResult(requirements=requirements, dropped_without_basis=dropped)
