import { createDemoApi } from "./demo/demoApi";
import { createHostedApi } from "./hosted/hostedApi";

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
  /** hosted：在线版，由页面直接调用 Claude，不需要配置 */
  provider: "mock" | "openai_compatible" | "hosted";
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
  provider: "mock" | "openai_compatible";
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
  /** 需要让使用者知道的运行状况，例如数据暂时无法保存 */
  warning?: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  /** 已经问过、客户不在意的方面，不再提示补问 */
  dismissed_probes: string[];
  /** 演示项目：内容是预置的示例。除了这个标记，用起来和普通项目一样。 */
  is_sample?: boolean;
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
  // 204 表示成功但没有内容（例如删除）。
  if (resp.status === 204) return undefined as T;
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
  /** 载入演示项目：一套预置的材料和需求。 */
  createSampleProject: () => request<Project>("/projects/sample", { method: "POST" }),
  updateProject: (
    id: number,
    patch: Partial<Pick<Project, "name" | "description" | "dismissed_probes">>,
  ) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProject: (id: number) => request<void>(`/projects/${id}`, { method: "DELETE" }),
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

/**
 * 构建方式（环境变量 VITE_MODE）：
 * - 不设置：完整版，连接自己部署的后端。
 * - hosted：在线版，发布在 Claude 上，数据存平台的存储，分析调用 Claude。
 * - demo：预览版，带示例数据，不保存、不调用模型。
 */
// 直接和字面量比较，打包工具才能在构建时确定走哪一支，并去掉用不到的代码。
export const IS_DEMO = import.meta.env.VITE_MODE === "demo";
export const IS_HOSTED = import.meta.env.VITE_MODE === "hosted";

export const api: Api = IS_HOSTED ? createHostedApi() : IS_DEMO ? createDemoApi() : realApi;
