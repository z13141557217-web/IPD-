from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

RequirementStatus = Literal["draft", "confirmed", "rejected"]
Priority = Literal["high", "medium", "low"]
ValidationStatus = Literal["unverified", "validated", "invalidated"]
DemandType = Literal["strategic", "project", "unknown"]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    # 客户背景：客户是谁、什么行业、用产品做什么。每次分析都会带上。
    description: str | None = Field(default=None, max_length=5000)


class ProjectOut(ORMModel):
    id: int
    name: str
    description: str
    owner: str
    created_at: datetime


class RawInputCreate(BaseModel):
    content: str = Field(min_length=1, max_length=50_000)
    source_type: str = Field(default="", max_length=50)


class RawInputOut(ORMModel):
    id: int
    project_id: int
    source_type: str
    content: str
    status: str
    error: str | None
    created_at: datetime


class RequirementOut(ORMModel):
    id: int
    project_id: int
    input_id: int | None
    title: str
    description: str
    source_quote: str
    quote_verified: bool
    appeals: str | None
    priority: str
    priority_reason: str
    kind: str
    demand_type: str
    stated_request: str
    underlying_problem: str
    reasoning: str
    confidence: str
    open_questions: list[str]
    based_on: list[int]
    validation_plan: str
    validation_status: str
    status: str
    duplicate_of_id: int | None
    created_at: datetime
    updated_at: datetime


class RequirementUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    appeals: str | None = None
    priority: Priority | None = None
    status: RequirementStatus | None = None
    underlying_problem: str | None = None
    validation_plan: str | None = None
    validation_status: ValidationStatus | None = None
    demand_type: DemandType | None = None
    # 追问清单：问到答案后把对应的问题去掉。
    open_questions: list[str] | None = Field(default=None, max_length=20)


class ExtractionResult(BaseModel):
    input: RawInputOut
    requirements: list[RequirementOut]


class LatentNeedsResult(BaseModel):
    requirements: list[RequirementOut]
    dropped_without_basis: int


class LLMCallOut(ORMModel):
    id: int
    project_id: int | None
    input_id: int | None
    task: str
    prompt_version: str
    provider: str
    model: str
    request: dict[str, Any]
    response: str | None
    error: str | None
    latency_ms: int
    created_at: datetime


class HealthOut(BaseModel):
    status: str
    llm_provider: str
    llm_model: str
    demo_mode: bool
