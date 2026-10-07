from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RawInput(Base):
    """用户提交的原始材料：客户反馈、访谈记录、会议纪要等。"""

    __tablename__ = "raw_inputs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[str] = mapped_column(String(100))
    source_type: Mapped[str] = mapped_column(String(50), default="")
    content: Mapped[str] = mapped_column(Text)
    # pending 尚未提取 / processed 已提取 / failed 提取失败，可重试
    status: Mapped[str] = mapped_column(String(20), default="pending")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Requirement(Base):
    __tablename__ = "requirements"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    input_id: Mapped[int | None] = mapped_column(
        ForeignKey("raw_inputs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by: Mapped[str] = mapped_column(String(100))

    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")

    # 依据：这条需求来自原始材料的哪句话，以及这句话是否真的能在材料里找到。
    source_quote: Mapped[str] = mapped_column(Text, default="")
    quote_verified: Mapped[bool] = mapped_column(Boolean, default=False)

    # $APPEALS 维度的 key，见 app/rules/appeals.yaml；无法归类时为空。
    appeals: Mapped[str | None] = mapped_column(String(30), nullable=True)
    priority: Mapped[str] = mapped_column(String(10), default="medium")
    priority_reason: Mapped[str] = mapped_column(Text, default="")

    # ---- 需求分析（挖掘本质与潜在需求）----
    # stated 客户明确提出的诉求，经分析还原出真实需求
    # latent 客户没有明说、由多条需求推断出的潜在需求假设
    kind: Mapped[str] = mapped_column(String(20), default="stated", server_default="stated")
    # 需求类型：strategic 关系到客户中长期经营方向的需求，会持续存在
    #          project   针对某一次交付或某个具体项目的个别要求
    #          unknown   材料不足以判断
    demand_type: Mapped[str] = mapped_column(String(20), default="unknown", server_default="unknown")
    # 客户表面上提的要求（常常是一个具体方案）。title/description 写的是分析后的真实需求。
    stated_request: Mapped[str] = mapped_column(Text, default="", server_default="")
    # 客户提这个要求，背后真正要解决的问题。
    underlying_problem: Mapped[str] = mapped_column(Text, default="", server_default="")
    # 从依据推到真实需求（或潜在需求）的推理过程，供人判断推得对不对。
    reasoning: Mapped[str] = mapped_column(Text, default="", server_default="")
    # 模型对这条推断的把握：high / medium / low
    confidence: Mapped[str] = mapped_column(String(10), default="low", server_default="low")
    # 需要回头向客户追问、用来证实或推翻这条推断的问题。
    open_questions: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    # 仅 latent：这条假设依据的是哪些已有需求（id 列表）。没有依据的假设不允许入库。
    based_on: Mapped[list[int]] = mapped_column(JSON, default=list, server_default="[]")
    # 仅 latent：建议的验证方式。
    validation_plan: Mapped[str] = mapped_column(Text, default="", server_default="")
    # unverified 未验证 / validated 已向客户验证成立 / invalidated 验证不成立
    validation_status: Mapped[str] = mapped_column(
        String(20), default="unverified", server_default="unverified"
    )

    # draft 模型给出、待人确认 / confirmed 已确认 / rejected 已否决
    # latent 类型的需求必须先验证成立才能确认。
    status: Mapped[str] = mapped_column(String(20), default="draft")
    duplicate_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("requirements.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class LLMCall(Base):
    """每一次模型调用的完整记录，用于核对依据和回归对比。"""

    __tablename__ = "llm_calls"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    input_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    task: Mapped[str] = mapped_column(String(50))
    prompt_version: Mapped[str] = mapped_column(String(20))
    provider: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(100))
    request: Mapped[dict[str, Any]] = mapped_column(JSON)
    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
