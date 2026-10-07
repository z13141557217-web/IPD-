from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

RequirementStatus = Literal["draft", "confirmed", "rejected"]
RequirementStatusFilter = Literal["draft", "confirmed", "rejected", "merged"]
Category = Literal["functional", "quality", "constraint", "unknown"]
Disposition = Literal["current", "next", "tech", "long", "undecided"]
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
    dismissed_probes: list[str] | None = Field(default=None, max_length=30)


class ProjectOut(ORMModel):
    id: int
    name: str
    description: str
    dismissed_probes: list[str]
    is_sample: bool
    owner: str
    created_at: datetime


class RawInputCreate(BaseModel):
    content: str = Field(min_length=1, max_length=50_000)
    source_type: str = Field(default="", max_length=50)
    requester: str = Field(default="", max_length=100)


class RawInputOut(ORMModel):
    id: int
    project_id: int
    source_type: str
    requester: str
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
    category: str
    subcategory: str | None
    disposition: str
    disposition_reason: str
    reject_reason: str
    # 以下两项不是数据库字段，由接口根据已并入的需求计算。
    mention_count: int = 1
    requesters: list[str] = []
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
    category: Category | None = None
    subcategory: str | None = None
    disposition: Disposition | None = None
    reject_reason: str | None = Field(default=None, max_length=2000)
    # 追问清单：问到答案后把对应的问题去掉。
    open_questions: list[str] | None = Field(default=None, max_length=20)


class ExtractionResult(BaseModel):
    input: RawInputOut
    requirements: list[RequirementOut]


class MergeRequest(BaseModel):
    target_id: int


class MergeResult(BaseModel):
    merged: RequirementOut
    target: RequirementOut


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


class LLMSettingsOut(BaseModel):
    provider: str
    base_url: str
    model: str
    # 密钥本身永远不返回，只说明有没有，以及末四位。
    api_key_set: bool
    api_key_hint: str
    # settings：在设置页保存的；env：来自环境变量
    source: str


class LLMSettingsUpdate(BaseModel):
    provider: Literal["mock", "openai_compatible"]
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=100)
    # 不传或传 null：保留原来的密钥；传空字符串：清除密钥
    api_key: str | None = Field(default=None, max_length=500)


class SettingsOut(BaseModel):
    version: str
    llm: LLMSettingsOut


class LLMTestResult(BaseModel):
    ok: bool
    latency_ms: int
    message: str


class HealthOut(BaseModel):
    version: str
    status: str
    llm_provider: str
    llm_model: str
    demo_mode: bool
