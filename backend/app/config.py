from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """运行配置，全部来自环境变量（或 .env 文件）。"""

    database_url: str = "postgresql+psycopg://ipd:ipd@localhost:5432/ipd"

    # 模型接入。provider 取值：
    #   mock              不调用任何模型，用简单规则拆分文本，仅供演示和测试
    #   openai_compatible 调用兼容 OpenAI Chat Completions 接口的服务（云端或本地推理服务）
    llm_provider: str = "mock"
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout_seconds: float = 120.0

    cors_origins: str = "http://localhost:5173"

    # 目前只有一个使用者；商业化前换成真实的登录用户。
    default_user: str = "local"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
