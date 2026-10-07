from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

_RULES_DIR = Path(__file__).parent


@lru_cache
def load_appeals() -> dict[str, Any]:
    with (_RULES_DIR / "appeals.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


@lru_cache
def load_classification() -> dict[str, Any]:
    with (_RULES_DIR / "classification.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


@lru_cache
def load_prompts() -> dict[str, Any]:
    with (_RULES_DIR / "prompts.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


@lru_cache
def load_sample_project() -> dict[str, Any]:
    """演示项目的内容。调用方不要修改返回值。"""
    with (_RULES_DIR / "sample_project.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def category_keys() -> set[str]:
    return {c["key"] for c in load_classification()["categories"]}


def subcategory_keys(category: str | None) -> set[str]:
    """某个类别下允许的子类。功能性需求没有子类。"""
    rules = load_classification()
    if category == "quality":
        return {q["key"] for q in rules["quality_attributes"]}
    if category == "constraint":
        return {c["key"] for c in rules["constraints"]}
    return set()


def disposition_keys() -> set[str]:
    return {d["key"] for d in load_classification()["dispositions"]}


def appeals_keys() -> set[str]:
    return {d["key"] for d in load_appeals()["dimensions"]}


def priority_keys() -> set[str]:
    return {p["key"] for p in load_appeals()["priorities"]}
