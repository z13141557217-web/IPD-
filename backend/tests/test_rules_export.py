import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def test_frontend_rules_copy_matches_yaml():
    """前端预览版用的规则副本必须与 YAML 一致。不一致时运行 scripts/export_rules.py。"""
    spec = importlib.util.spec_from_file_location("export_rules", ROOT / "scripts" / "export_rules.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    exported = json.loads((ROOT / "frontend" / "src" / "demo" / "rules.json").read_text(encoding="utf-8"))
    assert exported == module.build()
