"""构建界面预览版：不连后端、带示例数据的一个静态页面。

    python3 scripts/build_preview.py

产物在 frontend/dist-preview/ 下：
    preview.html  页面内容（样式内联，不含 <html>/<head>/<body>，由发布平台补上）
    app.js        脚本
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
OUT = FRONTEND / "dist-preview"


def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    subprocess.run(
        ["npx", "vite", "build", "--outDir", "dist-preview", "--base", "./"],
        cwd=FRONTEND,
        env={**os.environ, "VITE_DEMO": "1"},
        check=True,
    )
    [js] = (OUT / "assets").glob("*.js")
    [css] = (OUT / "assets").glob("*.css")
    shutil.copy(js, OUT / "app.js")
    style = css.read_text(encoding="utf-8")
    page = (
        "<title>IPD 需求助手预览</title>\n"
        f"<style>\n{style}\n</style>\n"
        '<div id="root"></div>\n'
        '<script type="module" src="app.js"></script>\n'
    )
    (OUT / "preview.html").write_text(page, encoding="utf-8")
    assert not re.search(r"https?://(?!www\.w3\.org)", style), "样式里不应引用外部资源"
    print(f"预览版已生成：{(OUT / 'preview.html').relative_to(ROOT)}，脚本 {js.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
