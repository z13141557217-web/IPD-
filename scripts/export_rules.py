"""把后端的规则数据导出成 JSON，供前端的预览版使用。

规则的唯一来源是 backend/app/rules/*.yaml。改了 YAML 之后运行：

    backend/.venv/bin/python scripts/export_rules.py

后端测试会检查导出的文件是否与 YAML 一致，忘了运行时测试会失败。
"""

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
RULES = ROOT / "backend" / "app" / "rules"
TARGET = ROOT / "frontend" / "src" / "demo" / "rules.json"


def build() -> dict:
    return {
        "appeals": yaml.safe_load((RULES / "appeals.yaml").read_text(encoding="utf-8")),
        "classification": yaml.safe_load((RULES / "classification.yaml").read_text(encoding="utf-8")),
    }


if __name__ == "__main__":
    TARGET.write_text(json.dumps(build(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {TARGET.relative_to(ROOT)}")
