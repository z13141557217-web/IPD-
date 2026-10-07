import httpx

from app.llm import providers

KEY = "sk-test-0123456789abcdef"


def _patch_post(monkeypatch, handler):
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update(url=url, headers=headers, json=json)
        return handler()

    monkeypatch.setattr(providers.httpx, "post", fake_post)
    return captured


def _save(client, **overrides):
    body = {
        "provider": "openai_compatible",
        "base_url": "https://llm.example.com/v1/",
        "model": "some-model",
        "api_key": KEY,
    }
    body.update(overrides)
    return client.put("/api/settings/llm", json=body)


def test_defaults_come_from_environment(client):
    body = client.get("/api/settings").json()
    assert body["version"]
    assert body["llm"] == {
        "provider": "mock",
        "base_url": "",
        "model": "",
        "api_key_set": False,
        "api_key_hint": "",
        "source": "env",
    }


def test_saved_settings_never_return_the_key(client):
    resp = _save(client)
    assert resp.status_code == 200
    llm = resp.json()
    assert llm["provider"] == "openai_compatible"
    assert llm["base_url"] == "https://llm.example.com/v1"
    assert llm["api_key_set"] is True
    assert llm["api_key_hint"] == "…cdef"
    assert llm["source"] == "settings"
    for response in (resp, client.get("/api/settings"), client.get("/api/health")):
        assert KEY not in response.text
    health = client.get("/api/health").json()
    assert (health["demo_mode"], health["llm_model"]) == (False, "some-model")


def test_omitting_key_keeps_it_and_empty_string_clears_it(client):
    _save(client)
    kept = _save(client, model="another-model", api_key=None).json()
    assert (kept["model"], kept["api_key_set"], kept["api_key_hint"]) == ("another-model", True, "…cdef")
    cleared = _save(client, api_key="").json()
    assert (cleared["api_key_set"], cleared["api_key_hint"]) == (False, "")


def test_short_keys_show_no_hint(client):
    assert _save(client, api_key="short").json()["api_key_hint"] == ""


def test_validation(client):
    assert _save(client, base_url="llm.example.com/v1").status_code == 422
    assert _save(client, base_url="ftp://x").status_code == 422
    assert _save(client, model="  ").status_code == 422
    assert _save(client, provider="other").status_code == 422
    # 演示模式不需要地址和模型
    assert client.put("/api/settings/llm", json={"provider": "mock"}).status_code == 200


def test_connection_test_uses_saved_settings(client, monkeypatch):
    assert client.post("/api/settings/llm/test").json()["ok"] is True  # 演示模式

    _save(client)
    captured = _patch_post(
        monkeypatch,
        lambda: httpx.Response(200, json={"choices": [{"message": {"content": "正常"}}]}),
    )
    result = client.post("/api/settings/llm/test").json()
    assert result["ok"] is True and "正常" in result["message"]
    assert captured["url"] == "https://llm.example.com/v1/chat/completions"
    assert captured["headers"]["Authorization"] == f"Bearer {KEY}"
    assert captured["json"]["model"] == "some-model"

    _patch_post(monkeypatch, lambda: httpx.Response(401, text="invalid api key"))
    failed = client.post("/api/settings/llm/test").json()
    assert failed["ok"] is False and "401" in failed["message"]
    assert KEY not in failed["message"]


def test_saved_settings_take_effect_for_analysis_without_restart(make_client, monkeypatch):
    """不注入测试用的提供方，走真实的“读取配置 → 调用模型”路径。"""
    from app.llm.gateway import LLMGateway, get_gateway

    client = make_client()
    client.app.dependency_overrides[get_gateway] = lambda: LLMGateway()
    pid = client.post("/api/projects", json={"name": "p"}).json()["id"]

    # 还没配置：走演示模式
    client.post(f"/api/projects/{pid}/inputs", json={"content": "设备开机太慢，要等两分钟。"})
    assert client.get(f"/api/projects/{pid}/llm-calls").json()[0]["provider"] == "mock"

    _save(client)
    reply = '{"requirements": [{"title": "缩短开机时间", "source_quote": "开机慢"}]}'
    _patch_post(
        monkeypatch, lambda: httpx.Response(200, json={"choices": [{"message": {"content": reply}}]})
    )
    body = client.post(f"/api/projects/{pid}/inputs", json={"content": "开机慢"}).json()
    assert body["requirements"][0]["title"] == "缩短开机时间"
    call = client.get(f"/api/projects/{pid}/llm-calls").json()[0]
    assert (call["provider"], call["model"]) == ("openai_compatible", "some-model")
    assert KEY not in str(call)  # 调用记录里不含密钥
