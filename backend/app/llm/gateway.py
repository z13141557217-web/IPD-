"""模型网关：业务代码调用模型的唯一入口。

负责两件事：按配置选择提供方；把每次调用完整记录到 llm_calls 表。
"""

import time

from sqlalchemy.orm import Session

from app.llm.providers import LLMError, MockProvider, OpenAICompatibleProvider, Provider
from app.models import LLMCall
from app.services.settings import LLMConfig, get_llm_config


def build_provider(config: LLMConfig) -> Provider:
    if config.provider == "mock":
        return MockProvider()
    if config.provider == "openai_compatible":
        return OpenAICompatibleProvider(
            base_url=config.base_url,
            api_key=config.api_key,
            model=config.model,
            timeout=config.timeout,
        )
    raise LLMError(f"不认识的模型接入方式：{config.provider}")


class LLMGateway:
    def __init__(self, provider: Provider | None = None) -> None:
        # 测试时可以直接传入一个提供方；正常运行时每次调用都读取当前配置，
        # 这样在设置页改完配置立即生效，不需要重启。
        self._provider = provider

    def _get_provider(self, config: LLMConfig) -> Provider:
        return self._provider or build_provider(config)

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
        config = get_llm_config(db)
        call = LLMCall(
            project_id=project_id,
            input_id=input_id,
            task=task,
            prompt_version=prompt_version,
            provider=config.provider,
            model=config.model or "",
            request={"system": system, "user": user},
        )
        started = time.monotonic()
        try:
            provider = self._get_provider(config)
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
