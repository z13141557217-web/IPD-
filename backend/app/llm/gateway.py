"""模型网关：业务代码调用模型的唯一入口。

负责两件事：按配置选择提供方；把每次调用完整记录到 llm_calls 表。
"""

import time

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.llm.providers import LLMError, MockProvider, OpenAICompatibleProvider, Provider
from app.models import LLMCall


def build_provider(settings: Settings) -> Provider:
    if settings.llm_provider == "mock":
        return MockProvider()
    if settings.llm_provider == "openai_compatible":
        return OpenAICompatibleProvider(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            timeout=settings.llm_timeout_seconds,
        )
    raise LLMError(f"不认识的 LLM_PROVIDER：{settings.llm_provider}")


class LLMGateway:
    def __init__(self, provider: Provider | None = None) -> None:
        self._provider = provider

    def _get_provider(self) -> Provider:
        if self._provider is None:
            self._provider = build_provider(get_settings())
        return self._provider

    def complete(
        self,
        db: Session,
        *,
        task: str,
        prompt_version: str,
        system: str,
        user: str,
        project_id: int | None = None,
        input_id: int | None = None,
    ) -> str:
        """调用模型并返回文本。无论成功失败都会写一条调用记录并立即提交。"""
        settings = get_settings()
        call = LLMCall(
            project_id=project_id,
            input_id=input_id,
            task=task,
            prompt_version=prompt_version,
            provider=settings.llm_provider,
            model=settings.llm_model or "",
            request={"system": system, "user": user},
        )
        started = time.monotonic()
        try:
            provider = self._get_provider()
            call.provider, call.model = provider.name, provider.model
            text = provider.complete(system, user)
            call.response = text
            return text
        except LLMError as exc:
            call.error = str(exc)
            raise
        finally:
            call.latency_ms = int((time.monotonic() - started) * 1000)
            db.add(call)
            db.commit()


_gateway = LLMGateway()


def get_gateway() -> LLMGateway:
    return _gateway
