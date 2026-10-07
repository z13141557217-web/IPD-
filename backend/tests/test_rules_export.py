import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GENERATED = ROOT / "frontend" / "src" / "generated"


def _load_export_module():
    spec = importlib.util.spec_from_file_location("export_rules", ROOT / "scripts" / "export_rules.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_generated_files_are_up_to_date():
    """在线版用的规则、提示词和对照样例必须与后端一致。不一致时运行 scripts/export_rules.py。"""
    module = _load_export_module()
    rules = json.loads((GENERATED / "rules.json").read_text(encoding="utf-8"))
    parity = json.loads((GENERATED / "parity.json").read_text(encoding="utf-8"))
    assert rules == json.loads(module.render(module.build_rules()))
    assert parity == json.loads(module.render(module.build_parity()))


def test_parity_cases_cover_both_success_and_failure():
    parity = json.loads((GENERATED / "parity.json").read_text(encoding="utf-8"))
    for name in ("parse_extraction", "parse_hypotheses"):
        assert any("expected" in c for c in parity[name])
        assert any(c.get("error") for c in parity[name])
