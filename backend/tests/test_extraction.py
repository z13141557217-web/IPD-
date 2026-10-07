import json

import pytest

from app.services.extraction import ExtractionError, parse_extraction

CONTENT = "设备开机太慢，要等两分钟。\n另外报价比竞品高了一成。"


def _wrap(items) -> str:
    return json.dumps({"requirements": items}, ensure_ascii=False)


def test_parses_json_wrapped_in_code_fence_and_prose():
    text = "好的，结果如下：\n```json\n" + _wrap(
        [
            {
                "title": "缩短开机时间",
                "description": "客户嫌开机慢",
                "source_quote": "设备开机太慢，要等两分钟。",
                "appeals": "performance",
                "priority": "high",
                "priority_reason": "客户明确抱怨",
                "duplicate_of": None,
            }
        ]
    ) + "\n```"
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["title"] == "缩短开机时间"
    assert req["appeals"] == "performance"
    assert req["priority"] == "high"
    assert req["quote_verified"] is True
    assert req["duplicate_of_id"] is None


def test_quote_not_in_material_is_flagged_unverified():
    text = _wrap([{"title": "增加蓝牙", "source_quote": "客户希望增加蓝牙功能"}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["quote_verified"] is False


def test_quote_matching_ignores_whitespace_differences():
    text = _wrap([{"title": "降价", "source_quote": "另外 报价比竞品高了一成"}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["quote_verified"] is True


def test_empty_quote_is_unverified():
    [req] = parse_extraction(_wrap([{"title": "降价"}]), content=CONTENT, existing_ids=set())
    assert req["quote_verified"] is False


def test_invalid_enum_values_fall_back_to_safe_defaults():
    text = _wrap([{"title": "x", "appeals": "不存在的维度", "priority": "urgent"}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["appeals"] is None
    assert req["priority"] == "medium"


@pytest.mark.parametrize("duplicate_of", [99, "3", True, 3.0])
def test_duplicate_of_must_be_a_known_integer_id(duplicate_of):
    text = _wrap([{"title": "x", "duplicate_of": duplicate_of}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids={1, 3})
    assert req["duplicate_of_id"] is None


def test_known_duplicate_id_is_kept():
    text = _wrap([{"title": "x", "duplicate_of": 3}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids={1, 3})
    assert req["duplicate_of_id"] == 3


def test_items_without_title_or_of_wrong_type_are_skipped():
    text = _wrap([{"title": "  "}, "不是对象", {"title": "保留"}])
    reqs = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert [r["title"] for r in reqs] == ["保留"]


@pytest.mark.parametrize(
    "text", ["抱歉，我无法处理。", "{不是 json}", '{"other": []}', '{"requirements": "x"}', "[]"]
)
def test_unusable_output_raises(text):
    with pytest.raises(ExtractionError):
        parse_extraction(text, content=CONTENT, existing_ids=set())


def test_analysis_fields_are_kept():
    text = _wrap(
        [
            {
                "stated_request": "希望开机快一点",
                "source_quote": "设备开机太慢，要等两分钟。",
                "underlying_problem": "巡检时每到一处都要重新开机，累计等待很长",
                "title": "巡检途中无需等待即可使用",
                "reasoning": "材料提到要等两分钟，但没有说明使用场景",
                "confidence": "medium",
                "open_questions": ["一天要开机多少次？", "  ", 3],
            }
        ]
    )
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["kind"] == "stated"
    assert req["stated_request"] == "希望开机快一点"
    assert req["underlying_problem"].startswith("巡检时")
    assert req["confidence"] == "medium"
    assert req["open_questions"] == ["一天要开机多少次？"]


@pytest.mark.parametrize("confidence", [None, "very high", 5])
def test_missing_or_invalid_confidence_is_treated_as_low(confidence):
    text = _wrap([{"title": "x", "confidence": confidence}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["confidence"] == "low"


@pytest.mark.parametrize(
    ("given", "expected"),
    [("strategic", "strategic"), ("project", "project"), (None, "unknown"), ("长期", "unknown")],
)
def test_demand_type_defaults_to_unknown(given, expected):
    text = _wrap([{"title": "x", "demand_type": given}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert req["demand_type"] == expected


@pytest.mark.parametrize(
    ("category", "subcategory", "expected"),
    [
        ("quality", "reliability", ("quality", "reliability")),
        ("constraint", "regulations", ("constraint", "regulations")),
        ("quality", "regulations", ("quality", None)),  # 子类不属于这个类别
        ("functional", "performance", ("functional", None)),  # 功能性需求没有子类
        ("别的", "reliability", ("unknown", None)),
        (None, None, ("unknown", None)),
    ],
)
def test_category_and_subcategory_are_validated_together(category, subcategory, expected):
    text = _wrap([{"title": "x", "category": category, "subcategory": subcategory}])
    [req] = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert (req["category"], req["subcategory"]) == expected


def test_disposition_defaults_to_undecided():
    text = _wrap(
        [
            {"title": "a", "disposition": "tech", "disposition_reason": "需要先做平台"},
            {"title": "b", "disposition": "马上做"},
        ]
    )
    a, b = parse_extraction(text, content=CONTENT, existing_ids=set())
    assert (a["disposition"], a["disposition_reason"]) == ("tech", "需要先做平台")
    assert b["disposition"] == "undecided"
