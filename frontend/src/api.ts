import { demoApi } from "./demo/demoApi";

export type Priority = "high" | "medium" | "low";
export type RequirementStatus = "draft" | "confirmed" | "rejected" | "merged";
export type Category = "functional" | "quality" | "constraint" | "unknown";
export type Disposition = "current" | "next" | "tech" | "long" | "undecided";
export type RequirementKind = "stated" | "latent";
export type Confidence = "high" | "medium" | "low";
export type ValidationStatus = "unverified" | "validated" | "invalidated";
/** strategic：客户中长期的需求；project：某一次项目的个别要求 */
export type DemandType = "strategic" | "project" | "unknown";

export interface LLMSettings {
  provider: "mock" | "openai_compatible";
  base_url: string;
  model: string;
  /** 密钥本身不会从后端返回，只知道有没有，以及末四位 */
  api_key_set: boolean;
  api_key_hint: string;
  /** settings：在设置页保存的；env：来自环境变量 */
  source: "settings" | "env";
}

export interface AppSettings {
  version: string;
  llm: LLMSettings;
}

export interface LLMSettingsUpdate {
  provider: LLMSettings["provider"];
  base_url: string;
  model: string;
  /** null：保留原来的密钥；空字符串：清除 */
  api_key: string | null;
}

export interface LLMTestResult {
  ok: boolean;
  latency_ms: number;
  message: string;
}

export interface Health {
  version: string;
  status: string;
  llm_provider: string;
  llm_model: string;
  demo_mode: boolean;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  /** 已经问过、客户不在意的方面，不再提示补问 */
  dismissed_probes: string[];
}

export interface RawInput {
  id: number;
  project_id: number;
  source_type: string;
  requester: string;
  content: string;
  status: "pending" | "processed" | "failed";
  error: string | null;
  created_at: string;
}

export interface Requirement {
  id: number;
  project_id: number;
  input_id: number | null;
  title: string;
  description: string;
  source_quote: string;
  quote_verified: boolean;
  appeals: string | null;
  priority: Priority;
  priority_reason: string;
  /** stated：客户明确提出的诉求；latent：客户没有明说的潜在需求假设 */
  kind: RequirementKind;
  category: Category;
  subcategory: string | null;
  disposition: Disposition;
  disposition_reason: string;
  reject_reason: string;
  /** 这条需求被提到几处（自己加上并入它的需求） */
  mention_count: number;
  requesters: string[];
  demand_type: DemandType;
  stated_request: string;
  underlying_problem: string;
  reasoning: string;
  confidence: Confidence;
  open_questions: string[];
  based_on: number[];
  validation_plan: string;
  validation_status: ValidationStatus;
  status: RequirementStatus;
  duplicate_of_id: number | null;
}

export interface LatentNeedsResult {
  requirements: Requirement[];
  dropped_without_basis: number;
}

export interface ExtractionResult {
  input: RawInput;
  requirements: Requirement[];
}

export interface AppealsDimension {
  key: string;
  code: string;
  name: string;
  description: string;
}

export interface QualityAttribute {
  key: string;
  name: string;
  description: string;
  probe: string;
}

export interface ClassificationRules {
  categories: { key: Category; name: string; description: string }[];
  quality_attributes: QualityAttribute[];
  constraints: { key: string; name: string }[];
  constraint_probe: string;
  dispositions: { key: Disposition; name: string; description: string }[];
}

export interface AppealsRules {
  dimensions: AppealsDimension[];
}

export type RequirementPatch = Partial<
  Pick<
    Requirement,
    | "title"
    | "description"
    | "appeals"
    | "priority"
    | "status"
    | "validation_status"
    | "demand_type"
    | "category"
    | "subcategory"
    | "disposition"
    | "reject_reason"
    | "open_questions"
  >
>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error("无法连接后端服务，请确认服务已启动。");
  }
  if (!resp.ok) {
    let detail = `请求失败（${resp.status}）`;
    try {
      const body = await resp.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // 响应不是 JSON 时保留默认提示
    }
    throw new Error(detail);
  }
  return resp.json() as Promise<T>;
}

const realApi = {
  health: () => request<Health>("/health"),
  getSettings: () => request<AppSettings>("/settings"),
  saveLlmSettings: (body: LLMSettingsUpdate) =>
    request<LLMSettings>("/settings/llm", { method: "PUT", body: JSON.stringify(body) }),
  testLlm: () => request<LLMTestResult>("/settings/llm/test", { method: "POST" }),
  appeals: () => request<AppealsRules>("/rules/appeals"),
  classification: () => request<ClassificationRules>("/rules/classification"),
  listProjects: () => request<Project[]>("/projects"),
  createProject: (name: string) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  updateProject: (
    id: number,
    patch: Partial<Pick<Project, "name" | "description" | "dismissed_probes">>,
  ) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  listRequirements: (projectId: number) =>
    request<Requirement[]>(`/projects/${projectId}/requirements`),
  listInputs: (projectId: number) => request<RawInput[]>(`/projects/${projectId}/inputs`),
  submitInput: (projectId: number, content: string, sourceType: string, requester: string) =>
    request<ExtractionResult>(`/projects/${projectId}/inputs`, {
      method: "POST",
      body: JSON.stringify({ content, source_type: sourceType, requester }),
    }),
  retryExtraction: (inputId: number) =>
    request<ExtractionResult>(`/inputs/${inputId}/extract`, { method: "POST" }),
  discoverLatentNeeds: (projectId: number) =>
    request<LatentNeedsResult>(`/projects/${projectId}/latent-needs`, { method: "POST" }),
  mergeRequirement: (id: number, targetId: number) =>
    request<{ merged: Requirement; target: Requirement }>(`/requirements/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({ target_id: targetId }),
    }),
  updateRequirement: (id: number, patch: RequirementPatch) =>
    request<Requirement>(`/requirements/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};

export type Api = typeof realApi;

/** 预览版：不连后端，数据在浏览器内存里，用于让人直接点开看界面。 */
export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

export const api: Api = IS_DEMO ? demoApi : realApi;
