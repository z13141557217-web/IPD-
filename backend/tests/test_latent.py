import json

import pytest

from app.llm.providers import LLMError, MockProvider
from app.services.latent import MAX_HYPOTHESES, parse_hypotheses
from app.services.parsing import ModelOutputError

MATERIAL = (
    "设备开机太慢，要等两分钟。\n报价比竞品高了一成，希望能给折扣。\n"
    "安装说明书看不懂，师傅装了一个小时。\n售后响应慢，报修三天没人管。"
)


def _wrap(items) -> str:
    return json.dumps({"hypotheses": items}, ensure_ascii=False)


class ScriptedProvider:
    """材料提取走演示规则，潜在需求分析返回预先写好的内容。"""

    name = "scripted"
    model = "none"

    def __init__(self, latent_output):
        self.latent_output = latent_output
        self.latent_prompts: list[str] = []

    def complete(self, system: str, user: str) -> str:
        if "<需求清单>" not in user:
            return MockProvider().complete(system, user)
        self.latent_prompts.append(user)
        output = self.latent_output
        if isinstance(output, Exception):
            raise output
        return output(user) if callable(output) else output


def _seed(client) -> tuple[int, list[int]]:
    pid = client.post("/api/projects", json={"name": "门锁"}).json()["id"]
    reqs = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ]
    return pid, [r["id"] for r in reqs]


# ---- 解析 ----


def test_hypothesis_without_valid_basis_is_dropped():
    text = _wrap(
        [
            {"title": "没有依据", "based_on": []},
            {"title": "依据不存在", "based_on": [99, "1", True]},
            {"title": "缺少字段"},
            {"title": "有依据", "based_on": [2, 99, 2, 1], "validation_plan": "访谈三家客户"},
        ]
    )
    kept, dropped = parse_hypotheses(text, known_ids={1, 2})
    assert dropped == 3
    assert [h["title"] for h in kept] == ["有依据"]
    assert kept[0]["based_on"] == [2, 1]
    assert kept[0]["kind"] == "latent"
    assert kept[0]["validation_status"] == "unverified"


def test_number_of_hypotheses_is_capped():
    text = _wrap([{"title": f"假设{i}", "based_on": [1]} for i in range(MAX_HYPOTHESES + 3)])
    kept, _ = parse_hypotheses(text, known_ids={1})
    assert len(kept) == MAX_HYPOTHESES


def test_unusable_latent_output_raises():
    with pytest.raises(ModelOutputError):
        parse_hypotheses("想不出来", known_ids={1})
    with pytest.raises(ModelOutputError):
        parse_hypotheses('{"requirements": []}', known_ids={1})


# ---- 接口 ----


def test_requires_minimum_number_of_requirements(make_client):
    provider = ScriptedProvider(_wrap([]))
    client = make_client(provider)
    pid = client.post("/api/projects", json={"name": "空项目"}).json()["id"]
    resp = client.post(f"/api/projects/{pid}/latent-needs")
    assert resp.status_code == 409
    assert "至少需要" in resp.json()["detail"]
    assert provider.latent_prompts == []  # 没有浪费一次模型调用


def test_discovers_latent_needs_grounded_in_existing_requirements(make_client):
    def output(user: str) -> str:
        return _wrap(
            [
                {
                    "title": "上门一次就能装好并用起来",
                    "description": "安装和首次使用不依赖师傅经验",
                    "based_on": ids[:2],
                    "reasoning": "安装耗时和售后响应慢都指向交付环节依赖人工",
                    "validation_plan": "跟装两户，记录卡在哪一步",
                    "open_questions": ["师傅装一把锁通常要多久？"],
                    "appeals": "ease_of_use",
                    "priority": "high",
                    "priority_reason": "两条需求都与此有关",
                },
                {"title": "凭空想出来的功能", "based_on": [9999]},
            ]
        )

    provider = ScriptedProvider(output)
    client = make_client(provider)
    pid, ids = _seed(client)

    resp = client.post(f"/api/projects/{pid}/latent-needs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["dropped_without_basis"] == 1
    [latent] = body["requirements"]
    assert latent["kind"] == "latent"
    assert latent["status"] == "draft"
    assert latent["validation_status"] == "unverified"
    assert latent["based_on"] == ids[:2]
    assert latent["input_id"] is None

    # 提示词里带上了已有需求的原话，供模型作为依据
    assert "售后响应慢" in provider.latent_prompts[0]

    # 再跑一次时，已有假设会告诉模型避免重复；被否决的需求不再作为依据
    client.patch(f"/api/requirements/{ids[0]}", json={"status": "rejected"})
    client.post(f"/api/projects/{pid}/latent-needs")
    second_prompt = provider.latent_prompts[1]
    assert "上门一次就能装好并用起来" in second_prompt.split("<需求清单>")[0]
    listed = json.loads(second_prompt.split("<需求清单>")[1].split("</需求清单>")[0])
    assert ids[0] not in {item["id"] for item in listed}
    assert all(item["id"] in ids for item in listed)  # 假设本身不作为新假设的依据

    calls = client.get(f"/api/projects/{pid}/llm-calls").json()
    assert sum(c["task"] == "discover_latent_needs" for c in calls) == 2


def test_latent_need_cannot_be_confirmed_before_validation(make_client):
    provider = ScriptedProvider(lambda user: _wrap([{"title": "潜在需求", "based_on": [ids[0]]}]))
    client = make_client(provider)
    pid, ids = _seed(client)
    lid = client.post(f"/api/projects/{pid}/latent-needs").json()["requirements"][0]["id"]

    blocked = client.patch(f"/api/requirements/{lid}", json={"status": "confirmed"})
    assert blocked.status_code == 422
    assert "验证" in blocked.json()["detail"]
    [still] = [r for r in client.get(f"/api/projects/{pid}/requirements").json() if r["id"] == lid]
    assert still["status"] == "draft"

    ok = client.patch(
        f"/api/requirements/{lid}", json={"validation_status": "validated", "status": "confirmed"}
    )
    assert ok.status_code == 200 and ok.json()["status"] == "confirmed"

    # 已确认的假设不能再被改回未验证
    back = client.patch(f"/api/requirements/{lid}", json={"validation_status": "unverified"})
    assert back.status_code == 422

    # 客户明确提出的需求不受这条限制
    assert (
        client.patch(f"/api/requirements/{ids[1]}", json={"status": "confirmed"}).status_code == 200
    )


@pytest.mark.parametrize("output", [LLMError("模型服务不可用"), "不是 JSON"])
def test_latent_failure_returns_502_and_stores_nothing(make_client, output):
    client = make_client(ScriptedProvider(output))
    pid, ids = _seed(client)
    resp = client.post(f"/api/projects/{pid}/latent-needs")
    assert resp.status_code == 502
    assert len(client.get(f"/api/projects/{pid}/requirements").json()) == len(ids)


def test_demo_mode_returns_no_hypotheses(client):
    pid, _ = _seed(client)
    body = client.post(f"/api/projects/{pid}/latent-needs").json()
    assert body == {"requirements": [], "dropped_without_basis": 0}
