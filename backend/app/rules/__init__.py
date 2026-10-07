from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

_RULES_DIR = Path(__file__).parent


@lru_cache
def load_appeals() -> dict[str, Any]:
    with (_RULES_DIR / "appeals.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def appeals_keys() -> set[str]:
    return {d["key"] for d in load_appeals()["dimensions"]}


def priority_keys() -> set[str]:
    return {p["key"] for p in load_appeals()["priorities"]}
