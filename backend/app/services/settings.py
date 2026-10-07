"""可以在界面上修改的设置。

模型接入的配置有两个来源：界面上保存的（存在数据库里）优先，没有保存过时用环境变量。
这样私有化部署时既可以用 .env 预置，也可以让使用者在设置页里自己填。

密钥只存不回显：接口只返回“是否已设置”和末四位，方便确认填的是哪一个。
"""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import AppSetting

LLM_KEYS = ("llm_provider", "llm_base_url", "llm_api_key", "llm_model")
PROVIDERS = ("mock", "openai_compatible")


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    base_url: str
    api_key: str
    model: str
    timeout: float
    # settings：界面上保存的；env：环境变量
    source: str


def _stored(db: Session) -> dict[str, str]:
    rows = db.query(AppSetting).filter(AppSetting.key.in_(LLM_KEYS)).all()
    return {row.key: row.value for row in rows}


def get_llm_config(db: Session) -> LLMConfig:
    env = get_settings()
    stored = _stored(db)
    if "llm_provider" in stored:
        return LLMConfig(
            provider=stored["llm_provider"],
            base_url=stored.get("llm_base_url", ""),
            api_key=stored.get("llm_api_key", ""),
            model=stored.get("llm_model", ""),
            timeout=env.llm_timeout_seconds,
            source="settings",
        )
    return LLMConfig(
        provider=env.llm_provider,
        base_url=env.llm_base_url,
        api_key=env.llm_api_key,
        model=env.llm_model,
        timeout=env.llm_timeout_seconds,
        source="env",
    )


def save_llm_config(
    db: Session, *, provider: str, base_url: str, model: str, api_key: str | None
) -> LLMConfig:
    """保存模型配置。api_key 为 None 表示保留原来的密钥，空字符串表示清除。"""
    current = get_llm_config(db)
    values = {
        "llm_provider": provider,
        "llm_base_url": base_url.strip().rstrip("/"),
        "llm_model": model.strip(),
        "llm_api_key": current.api_key if api_key is None else api_key.strip(),
    }
    existing = {row.key: row for row in db.query(AppSetting).filter(AppSetting.key.in_(LLM_KEYS))}
    for key, value in values.items():
        if key in existing:
            existing[key].value = value
        else:
            db.add(AppSetting(key=key, value=value))
    db.commit()
    return get_llm_config(db)


def key_hint(api_key: str) -> str:
    """只露出末四位。太短的密钥不露任何字符。"""
    return f"…{api_key[-4:]}" if len(api_key) >= 12 else ""
