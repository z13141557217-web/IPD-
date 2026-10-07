import httpx
import pytest

from app.llm import providers
from app.llm.providers import LLMError, OpenAICompatibleProvider


def _provider() -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        base_url="http://llm.internal/v1/", api_key="secret", model="some-model", timeout=5
    )


def _patch_post(monkeypatch, handler):
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update(url=url, headers=headers, json=json, timeout=timeout)
        return handler()

    monkeypatch.setattr(providers.httpx, "post", fake_post)
    return captured


def test_sends_chat_completion_request_and_returns_content(monkeypatch):
    captured = _patch_post(
        monkeypatch,
        lambda: httpx.Response(200, json={"choices": [{"message": {"content": "你好"}}]}),
    )
    assert _provider().complete("系统提示", "用户输入") == "你好"
    assert captured["url"] == "http://llm.internal/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer secret"
    assert captured["json"]["model"] == "some-model"
    assert [m["role"] for m in captured["json"]["messages"]] == ["system", "user"]


def test_omits_authorization_header_without_api_key(monkeypatch):
    captured = _patch_post(
        monkeypatch,
        lambda: httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]}),
    )
    OpenAICompatibleProvider("http://local/v1", "", "m", 5).complete("s", "u")
    assert "Authorization" not in captured["headers"]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, text="invalid key"),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"choices": [{"message": {"content": "  "}}]}),
        httpx.Response(200, json={"choices": [{"message": {"content": None}}]}),
    ],
)
def test_bad_responses_raise_llm_error(monkeypatch, response):
    _patch_post(monkeypatch, lambda: response)
    with pytest.raises(LLMError):
        _provider().complete("s", "u")


def test_connection_failure_raises_llm_error(monkeypatch):
    def boom():
        raise httpx.ConnectError("connection refused")

    _patch_post(monkeypatch, boom)
    with pytest.raises(LLMError, match="无法连接"):
        _provider().complete("s", "u")


def test_missing_configuration_raises_llm_error():
    with pytest.raises(LLMError):
        OpenAICompatibleProvider("", "k", "m", 5)
    with pytest.raises(LLMError):
        OpenAICompatibleProvider("http://x/v1", "k", "", 5)
