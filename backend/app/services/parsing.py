"""解析模型输出的公共工具。对模型输出不做任何信任假设。"""

import json
import re
from typing import Any


class ModelOutputError(Exception):
    """模型输出无法解析成约定的结构。"""


def load_json_object(text: str) -> dict[str, Any]:
    """取出模型输出中的 JSON 对象，容忍前后的说明文字和代码块标记。"""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ModelOutputError("模型输出中没有 JSON 对象")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise ModelOutputError(f"模型输出不是合法的 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise ModelOutputError("模型输出不是 JSON 对象")
    return data


def get_list(data: dict[str, Any], key: str) -> list[Any]:
    items = data.get(key)
    if not isinstance(items, list):
        raise ModelOutputError(f"模型输出缺少 {key} 列表")
    return items


def text_of(item: dict[str, Any], key: str) -> str:
    value = item.get(key)
    return value.strip() if isinstance(value, str) else ""


def text_list(value: Any, limit: int = 10) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned = [v.strip() for v in value if isinstance(v, str) and v.strip()]
    return cleaned[:limit]


def known_id(value: Any, known: set[int]) -> int | None:
    # bool 是 int 的子类，要单独排除。
    if isinstance(value, int) and not isinstance(value, bool) and value in known:
        return value
    return None


def choice(value: Any, allowed: set[str], default: str | None) -> str | None:
    return value if isinstance(value, str) and value in allowed else default


def normalize(text: str) -> str:
    return re.sub(r"\s+", "", text)
