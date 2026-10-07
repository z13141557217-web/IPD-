from app.llm.providers import LLMError

MATERIAL = "设备开机太慢，要等两分钟。\n另外报价比竞品高了一成，希望能给折扣。"


class FailingProvider:
    name = "failing"
    model = "none"

    def complete(self, system: str, user: str) -> str:
        raise LLMError("模型服务不可用")


class GarbageProvider:
    name = "garbage"
    model = "none"

    def complete(self, system: str, user: str) -> str:
        return "我不知道"


def _project(client) -> int:
    resp = client.post("/api/projects", json={"name": "测试产品"})
    assert resp.status_code == 201
    return resp.json()["id"]


def test_health_reports_demo_mode(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["demo_mode"] is True


def test_appeals_rules_have_eight_dimensions(client):
    dims = client.get("/api/rules/appeals").json()["dimensions"]
    assert len(dims) == 8
    assert len({d["key"] for d in dims}) == 8


def test_submit_input_extracts_requirements_with_verified_quotes(client):
    pid = _project(client)
    resp = client.post(
        f"/api/projects/{pid}/inputs", json={"content": MATERIAL, "source_type": "客户反馈"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["input"]["status"] == "processed"
    reqs = body["requirements"]
    assert len(reqs) == 2
    assert all(r["quote_verified"] and r["status"] == "draft" for r in reqs)
    assert {r["appeals"] for r in reqs} == {"performance", "price"}

    listed = client.get(f"/api/projects/{pid}/requirements").json()
    assert {r["id"] for r in listed} == {r["id"] for r in reqs}


def test_resubmitting_same_material_marks_duplicates(client):
    pid = _project(client)
    first = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()
    second = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()
    first_ids = {r["id"] for r in first["requirements"]}
    assert {r["duplicate_of_id"] for r in second["requirements"]} == first_ids


def test_llm_call_is_logged_with_prompt_and_response(client):
    pid = _project(client)
    client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL})
    [call] = client.get(f"/api/projects/{pid}/llm-calls").json()
    assert call["task"] == "extract_requirements"
    assert call["prompt_version"] == "v4"
    assert call["provider"] == "mock"
    assert MATERIAL in call["request"]["user"]
    assert call["response"] and call["error"] is None


def test_llm_failure_keeps_input_and_allows_retry(make_client):
    failing = make_client(FailingProvider())
    pid = _project(failing)
    body = failing.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()
    assert body["input"]["status"] == "failed"
    assert "不可用" in body["input"]["error"]
    assert body["requirements"] == []
    [call] = failing.get(f"/api/projects/{pid}/llm-calls").json()
    assert call["error"] and call["response"] is None

    # 同一个数据库，换成可用的模型后重试
    working = make_client()
    retried = working.post(f"/api/inputs/{body['input']['id']}/extract")
    assert retried.status_code == 200
    assert retried.json()["input"]["status"] == "processed"
    assert retried.json()["input"]["error"] is None
    assert len(retried.json()["requirements"]) == 2

    again = working.post(f"/api/inputs/{body['input']['id']}/extract")
    assert again.status_code == 409


def test_unparseable_model_output_marks_input_failed(make_client):
    client = make_client(GarbageProvider())
    pid = _project(client)
    body = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()
    assert body["input"]["status"] == "failed"
    assert client.get(f"/api/projects/{pid}/requirements").json() == []


def test_update_requirement_and_filter_by_status(client):
    pid = _project(client)
    reqs = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ]
    rid = reqs[0]["id"]
    resp = client.patch(
        f"/api/requirements/{rid}",
        json={
            "status": "confirmed",
            "disposition": "next",
            "priority": "high",
            "appeals": None,
            "title": " 新标题 ",
        },
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert (updated["status"], updated["priority"], updated["appeals"], updated["title"]) == (
        "confirmed",
        "high",
        None,
        "新标题",
    )
    confirmed = client.get(f"/api/projects/{pid}/requirements", params={"status": "confirmed"})
    assert [r["id"] for r in confirmed.json()] == [rid]


def test_update_rejects_invalid_values(client):
    pid = _project(client)
    rid = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ][0]["id"]
    assert client.patch(f"/api/requirements/{rid}", json={"appeals": "nope"}).status_code == 422
    assert client.patch(f"/api/requirements/{rid}", json={"priority": "urgent"}).status_code == 422
    assert client.patch(f"/api/requirements/{rid}", json={"status": None}).status_code == 422


def test_missing_resources_return_404_and_blank_input_422(client):
    assert client.get("/api/projects/999/requirements").status_code == 404
    assert client.post("/api/projects/999/inputs", json={"content": "x"}).status_code == 404
    assert client.patch("/api/requirements/999", json={"priority": "low"}).status_code == 404
    pid = _project(client)
    assert client.post(f"/api/projects/{pid}/inputs", json={"content": "   "}).status_code == 422
    assert client.post("/api/projects", json={"name": ""}).status_code == 422


def test_project_background_is_saved_and_sent_to_the_model(client):
    pid = _project(client)
    background = "客户是连锁公寓运营商，一个管家负责两百间房的门锁。"
    resp = client.patch(f"/api/projects/{pid}", json={"description": f"  {background}  "})
    assert resp.status_code == 200
    assert resp.json()["description"] == background
    assert resp.json()["name"] == "测试产品"  # 没传的字段不变

    client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL})
    [call] = client.get(f"/api/projects/{pid}/llm-calls").json()
    prompt = call["request"]["user"]
    assert background in prompt.split("</项目背景>")[0]
    assert background not in prompt.split("<材料")[1]  # 背景不混进材料，不能被当作原话引用


def test_empty_background_is_marked_as_missing_in_prompt(client):
    pid = _project(client)
    client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL})
    [call] = client.get(f"/api/projects/{pid}/llm-calls").json()
    assert "（未填写）" in call["request"]["user"].split("</项目背景>")[0]


def test_project_update_validation(client):
    pid = _project(client)
    assert client.patch(f"/api/projects/{pid}", json={"name": "  "}).status_code == 422
    assert client.patch(f"/api/projects/{pid}", json={"description": None}).status_code == 422
    assert client.patch("/api/projects/999", json={"name": "x"}).status_code == 404
    renamed = client.patch(f"/api/projects/{pid}", json={"name": " 新名字 "})
    assert renamed.json()["name"] == "新名字"


def test_open_questions_and_demand_type_can_be_updated(client):
    pid = _project(client)
    rid = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ][0]["id"]
    resp = client.patch(
        f"/api/requirements/{rid}",
        json={"open_questions": ["一天开机几次？", "  "], "demand_type": "strategic"},
    )
    assert resp.status_code == 200
    assert resp.json()["open_questions"] == ["一天开机几次？"]
    assert resp.json()["demand_type"] == "strategic"
    cleared = client.patch(f"/api/requirements/{rid}", json={"open_questions": []})
    assert cleared.json()["open_questions"] == []
    assert client.patch(f"/api/requirements/{rid}", json={"demand_type": "x"}).status_code == 422


def test_confirming_requires_a_disposition(client):
    pid = _project(client)
    rid = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ][0]["id"]
    blocked = client.patch(f"/api/requirements/{rid}", json={"status": "confirmed"})
    assert blocked.status_code == 422
    assert "去向" in blocked.json()["detail"]
    ok = client.patch(f"/api/requirements/{rid}", json={"status": "confirmed", "disposition": "current"})
    assert ok.status_code == 200
    # 已确认的需求不能把去向改回未定，但其他字段照常可改
    assert client.patch(f"/api/requirements/{rid}", json={"disposition": "undecided"}).status_code == 422
    assert client.patch(f"/api/requirements/{rid}", json={"priority": "low"}).status_code == 200
    assert client.patch(f"/api/requirements/{rid}", json={"disposition": "x"}).status_code == 422


def test_reject_reason_is_stored(client):
    pid = _project(client)
    rid = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ][0]["id"]
    resp = client.patch(
        f"/api/requirements/{rid}", json={"status": "rejected", "reject_reason": "只有一家客户提，且有替代办法"}
    )
    assert resp.status_code == 200
    assert resp.json()["reject_reason"] == "只有一家客户提，且有替代办法"


def test_category_and_subcategory_must_agree(client):
    pid = _project(client)
    rid = client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL}).json()[
        "requirements"
    ][0]["id"]
    ok = client.patch(
        f"/api/requirements/{rid}", json={"category": "quality", "subcategory": "reliability"}
    )
    assert (ok.json()["category"], ok.json()["subcategory"]) == ("quality", "reliability")
    # 子类不属于这个类别
    bad = client.patch(f"/api/requirements/{rid}", json={"subcategory": "regulations"})
    assert bad.status_code == 422
    # 只改类别时，不再适用的子类自动清掉
    changed = client.patch(f"/api/requirements/{rid}", json={"category": "functional"})
    assert (changed.json()["category"], changed.json()["subcategory"]) == ("functional", None)


def test_classification_rules_are_served(client):
    rules = client.get("/api/rules/classification").json()
    assert [c["key"] for c in rules["categories"]] == ["functional", "quality", "constraint"]
    assert all(q["probe"] for q in rules["quality_attributes"])
    assert {d["key"] for d in rules["dispositions"]} == {"current", "next", "tech", "long"}


def test_requester_is_saved_and_sent_to_the_model(client):
    pid = _project(client)
    body = client.post(
        f"/api/projects/{pid}/inputs", json={"content": MATERIAL, "requester": " 城南公寓 "}
    ).json()
    assert body["input"]["requester"] == "城南公寓"
    assert body["requirements"][0]["requesters"] == ["城南公寓"]
    assert body["requirements"][0]["mention_count"] == 1
    [call] = client.get(f"/api/projects/{pid}/llm-calls").json()
    assert '提出者="城南公寓"' in call["request"]["user"]


def test_project_can_dismiss_probes(client):
    pid = _project(client)
    resp = client.patch(f"/api/projects/{pid}", json={"dismissed_probes": ["security", "constraint"]})
    assert resp.json()["dismissed_probes"] == ["security", "constraint"]
    assert resp.json()["name"] == "测试产品"


def test_delete_project_removes_everything_under_it(client):
    keep = _project(client)
    client.post(f"/api/projects/{keep}/inputs", json={"content": MATERIAL})
    doomed = _project(client)
    client.post(f"/api/projects/{doomed}/inputs", json={"content": MATERIAL})
    client.post(f"/api/projects/{doomed}/inputs", json={"content": "安装说明书看不懂。"})

    assert client.delete(f"/api/projects/{doomed}").status_code == 204
    assert [p["id"] for p in client.get("/api/projects").json()] == [keep]
    for path in ("requirements", "inputs", "llm-calls"):
        assert client.get(f"/api/projects/{doomed}/{path}").status_code == 404
    # 另一个项目不受影响
    assert len(client.get(f"/api/projects/{keep}/requirements").json()) == 2
    assert len(client.get(f"/api/projects/{keep}/inputs").json()) == 1
    assert len(client.get(f"/api/projects/{keep}/llm-calls").json()) == 1
    assert client.delete(f"/api/projects/{doomed}").status_code == 404


def test_deleted_project_leaves_no_rows_behind(client, session_factory):
    from sqlalchemy import func, select

    from app.models import LLMCall, RawInput, Requirement

    pid = _project(client)
    client.post(f"/api/projects/{pid}/inputs", json={"content": MATERIAL})
    client.delete(f"/api/projects/{pid}")
    with session_factory() as db:
        for model in (Requirement, RawInput, LLMCall):
            assert db.scalar(select(func.count()).select_from(model)) == 0
