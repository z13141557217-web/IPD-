"""构建不需要自己部署后端的页面版本。

    python3 scripts/build_page.py hosted   # 在线版：数据存发布平台，分析调用 Claude
    python3 scripts/build_page.py demo     # 预览版：带示例数据，不保存、不调用模型

产物在 frontend/dist-<模式>/ 下：
    page.html  页面内容（样式内联，不含 <html>/<head>/<body>，由发布平台补上）
    app.js     脚本
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
TITLES = {"hosted": "IPD 需求助手", "demo": "IPD 需求助手预览"}


def main(mode: str) -> None:
    out = FRONTEND / f"dist-{mode}"
    shutil.rmtree(out, ignore_errors=True)
    subprocess.run(
        ["npx", "vite", "build", "--outDir", out.name, "--base", "./"],
        cwd=FRONTEND,
        env={**os.environ, "VITE_MODE": mode},
        check=True,
    )
    [js] = (out / "assets").glob("*.js")
    [css] = (out / "assets").glob("*.css")
    shutil.copy(js, out / "app.js")
    style = css.read_text(encoding="utf-8")
    assert not re.search(r"https?://(?!www\.w3\.org)", style), "样式里不应引用外部资源"
    page = (
        f"<title>{TITLES[mode]}</title>\n"
        f"<style>\n{style}\n</style>\n"
        '<div id="root"></div>\n'
        '<script type="module" src="app.js"></script>\n'
    )
    (out / "page.html").write_text(page, encoding="utf-8")
    print(f"已生成 {(out / 'page.html').relative_to(ROOT)}，脚本 {js.stat().st_size // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in TITLES:
        sys.exit("用法：python3 scripts/build_page.py hosted|demo")
    main(sys.argv[1])
