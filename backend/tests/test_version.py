import json
import re
from pathlib import Path

from app.version import __version__

ROOT = Path(__file__).resolve().parent.parent.parent


def test_version_is_the_same_everywhere():
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__)
    assert (ROOT / "VERSION").read_text(encoding="utf-8").strip() == __version__
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert package["version"] == __version__


def test_changelog_has_an_entry_for_this_version():
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"## [{__version__}]" in changelog
