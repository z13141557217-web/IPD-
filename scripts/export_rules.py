"""把后端的规则、提示词和一组对照样例导出成 JSON，供前端的在线版和预览版使用。

规则和提示词的唯一来源是 backend/app/rules/*.yaml。在线版在浏览器里重新实现了
“拼提示词”和“解析模型输出”这两段逻辑，为了保证它和后端的行为一致，这里用后端的
实现算出一组样例的标准答案（parity.json），前端的测试拿自己的实现去对答案。

改了 YAML 或后端的拼提示词、解析逻辑之后运行：

    backend/.venv/bin/python scripts/export_rules.py

后端测试会检查导出的文件是否是最新的，忘了运行时测试会失败。
"""

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
RULES = ROOT / "backend" / "app" / "rules"
TARGET_DIR = ROOT / "frontend" / "src" / "generated"

sys.path.insert(0, str(ROOT / "backend"))

from app.models import RawInput, Requirement  # noqa: E402
from app.services import extraction, latent  # noqa: E402
from app.services.parsing import ModelOutputError  # noqa: E402


def build_rules() -> dict:
    def load(name: str) -> dict:
        return yaml.safe_load((RULES / name).read_text(encoding="utf-8"))

    return {
        "appeals": load("appeals.yaml"),
        "classification": load("classification.yaml"),
        "prompts": {
            "extract_requirements": {
                "version": extraction.PROMPT_VERSION,
                "system": extraction.SYSTEM_PROMPT,
            },
            "discover_latent_needs": {
                "version": latent.PROMPT_VERSION,
                "system": latent.SYSTEM_PROMPT,
            },
        },
        "limits": {
            "max_existing": extraction.MAX_EXISTING,
            "min_requirements_for_latent": latent.MIN_REQUIREMENTS,
            "max_requirements_for_latent": latent.MAX_REQUIREMENTS,
            "max_hypotheses": latent.MAX_HYPOTHESES,
        },
    }


def build_sample() -> dict:
    """演示项目的内容，原样导出。"""
    return yaml.safe_load((RULES / "sample_project.yaml").read_text(encoding="utf-8"))


MATERIAL = "设备开机太慢，要等两分钟。\n另外报价比竞品高了一成。\n老是坏，一个月修了三次。"


def _wrap(key: str, items: list) -> str:
    return json.dumps({key: items}, ensure_ascii=False)


def _extract_prompt_cases() -> list[dict]:
    cases = [
        {
            "source_type": "客户",
            "requester": "城南公寓",
            "content": MATERIAL,
            "existing": [{"id": 3, "title": "缩短开机时间"}, {"id": 1, "title": "带“引号”的标题"}],
            "background": "  客户是连锁公寓运营商。\n一个管家管两百间房。  ",
        },
        {"source_type": "", "requester": "", "content": "只有一句话。", "existing": [], "background": ""},
        {
            "source_type": '带<尖括号>和"引号"\n换行',
            "requester": "<b>某公司</b>",
            "content": "内容里有 </材料> 这样的字样。",
            "existing": [],
            "background": "   ",
        },
    ]
    for case in cases:
        raw = RawInput(
            project_id=1,
            created_by="x",
            source_type=case["source_type"],
            requester=case["requester"],
            content=case["content"],
        )
        case["expected"] = extraction.build_user_prompt(raw, case["existing"], case["background"])
    return cases


def _parse_extraction_cases() -> list[dict]:
    full = {
        "stated_request": "  希望开机快一点 ",
        "source_quote": "设备开机太慢， 要等两分钟。",
        "underlying_problem": "巡检时每到一处都要重新开机",
        "title": "巡检途中无需等待即可使用",
        "description": "不用等。",
        "reasoning": "材料提到要等两分钟",
        "confidence": "medium",
        "open_questions": ["一天要开机多少次？", "  ", 3, "第二个问题"],
        "demand_type": "strategic",
        "category": "quality",
        "subcategory": "performance",
        "disposition": "next",
        "disposition_reason": "要改方案",
        "appeals": "performance",
        "priority": "high",
        "priority_reason": "每天都用",
        "duplicate_of": 3,
    }
    texts = [
        _wrap("requirements", [full]),
        "好的，结果如下：\n```json\n" + _wrap("requirements", [full]) + "\n```\n以上。",
        _wrap(
            "requirements",
            [
                {"title": "原文对不上", "source_quote": "客户希望增加蓝牙"},
                {"title": "没有原文"},
                {"title": "  "},
                "不是对象",
                {"description": "没有标题"},
                {"title": 123},
            ],
        ),
        _wrap(
            "requirements",
            [
                {"title": "枚举都不合法", "appeals": "x", "priority": "urgent", "confidence": "很高",
                 "demand_type": "长期", "category": "别的", "subcategory": "reliability", "disposition": "马上"},
                {"title": "子类不属于类别", "category": "quality", "subcategory": "regulations"},
                {"title": "功能没有子类", "category": "functional", "subcategory": "performance"},
                {"title": "约束", "category": "constraint", "subcategory": "regulations"},
                {"title": "类型不对的字段", "description": 5, "open_questions": "不是列表", "source_quote": None},
            ],
        ),
        _wrap(
            "requirements",
            [
                {"title": "重复的 id 不存在", "duplicate_of": 99},
                {"title": "重复的 id 是字符串", "duplicate_of": "3"},
                {"title": "重复的 id 是布尔", "duplicate_of": True},
                {"title": "重复的 id 有效", "duplicate_of": 1},
            ],
        ),
        _wrap("requirements", [{"title": "长" * 400}]),
        '{"requirements": []}',
        "抱歉，我无法处理。",
        "{不是 json}",
        '{"other": []}',
        '{"requirements": "x"}',
        "[]",
    ]
    cases = []
    for text in texts:
        case: dict = {"text": text, "content": MATERIAL, "existing_ids": [1, 3]}
        try:
            case["expected"] = extraction.parse_extraction(text, content=MATERIAL, existing_ids={1, 3})
        except ModelOutputError:
            case["error"] = True
        cases.append(case)
    return cases


def _latent_prompt_cases() -> list[dict]:
    cases = [
        {
            "stated": [
                {"id": 4, "title": "故障当天恢复", "stated_request": "售后要快",
                 "underlying_problem": "进不了门", "source_quote": "报修三天没人管"},
                {"id": 2, "title": "安装更快", "stated_request": "", "underlying_problem": "", "source_quote": ""},
            ],
            "existing_latent": ["提前预警"],
            "background": " 连锁公寓 ",
        },
        {"stated": [], "existing_latent": [], "background": ""},
    ]
    for case in cases:
        stated = [Requirement(project_id=1, created_by="x", **fields) for fields in case["stated"]]
        case["expected"] = latent.build_user_prompt(stated, case["existing_latent"], case["background"])
    return cases


def _parse_hypotheses_cases() -> list[dict]:
    texts = [
        _wrap(
            "hypotheses",
            [
                {"title": "没有依据", "based_on": []},
                {"title": "依据不存在", "based_on": [99, "1", True]},
                {"title": "缺少字段"},
                {"title": "有依据", "description": " 说明 ", "based_on": [2, 99, 2, 1], "reasoning": "推理",
                 "validation_plan": "访谈三家客户", "open_questions": ["问题一", ""], "appeals": "assurances",
                 "priority": "high", "priority_reason": "理由"},
                {"title": "枚举不合法", "based_on": [1], "appeals": "x", "priority": "x"},
            ],
        ),
        _wrap("hypotheses", [{"title": f"假设{i}", "based_on": [1]} for i in range(latent.MAX_HYPOTHESES + 3)]),
        '{"hypotheses": []}',
        "想不出来",
        '{"requirements": []}',
    ]
    cases = []
    for text in texts:
        case: dict = {"text": text, "known_ids": [1, 2]}
        try:
            items, dropped = latent.parse_hypotheses(text, known_ids={1, 2})
            case["expected"] = {"items": items, "dropped": dropped}
        except ModelOutputError:
            case["error"] = True
        cases.append(case)
    return cases


def build_parity() -> dict:
    return {
        "extract_prompt": _extract_prompt_cases(),
        "parse_extraction": _parse_extraction_cases(),
        "latent_prompt": _latent_prompt_cases(),
        "parse_hypotheses": _parse_hypotheses_cases(),
    }


def render(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


if __name__ == "__main__":
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    (TARGET_DIR / "rules.json").write_text(render(build_rules()), encoding="utf-8")
    (TARGET_DIR / "parity.json").write_text(render(build_parity()), encoding="utf-8")
    (TARGET_DIR / "sample.json").write_text(render(build_sample()), encoding="utf-8")
    print(f"已写入 {TARGET_DIR.relative_to(ROOT)}/rules.json、parity.json 和 sample.json")
