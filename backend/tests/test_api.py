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
    assert call["prompt_version"] == "v1"
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
        json={"status": "confirmed", "priority": "high", "appeals": None, "title": " 新标题 "},
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
