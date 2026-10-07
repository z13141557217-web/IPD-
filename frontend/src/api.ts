export type Priority = "high" | "medium" | "low";
export type RequirementStatus = "draft" | "confirmed" | "rejected";

export interface Health {
  status: string;
  llm_provider: string;
  llm_model: string;
  demo_mode: boolean;
}

export interface Project {
  id: number;
  name: string;
  description: string;
}

export interface RawInput {
  id: number;
  project_id: number;
  source_type: string;
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
  status: RequirementStatus;
  duplicate_of_id: number | null;
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

export interface AppealsRules {
  dimensions: AppealsDimension[];
}

export type RequirementPatch = Partial<
  Pick<Requirement, "title" | "description" | "appeals" | "priority" | "status">
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

export const api = {
  health: () => request<Health>("/health"),
  appeals: () => request<AppealsRules>("/rules/appeals"),
  listProjects: () => request<Project[]>("/projects"),
  createProject: (name: string) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  listRequirements: (projectId: number) =>
    request<Requirement[]>(`/projects/${projectId}/requirements`),
  listInputs: (projectId: number) => request<RawInput[]>(`/projects/${projectId}/inputs`),
  submitInput: (projectId: number, content: string, sourceType: string) =>
    request<ExtractionResult>(`/projects/${projectId}/inputs`, {
      method: "POST",
      body: JSON.stringify({ content, source_type: sourceType }),
    }),
  retryExtraction: (inputId: number) =>
    request<ExtractionResult>(`/inputs/${inputId}/extract`, { method: "POST" }),
  updateRequirement: (id: number, patch: RequirementPatch) =>
    request<Requirement>(`/requirements/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};
