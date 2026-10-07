/**
 * 不依赖服务器的后端：在浏览器里实现和真实后端相同的接口与业务规则。
 *
 * 在线版用它（数据存到发布平台的存储，分析调用模型），预览版也用它（数据放内存，不调模型）。
 * 业务规则与 backend/app/api/routes.py 保持一致：确认前要有去向、假设要先验证、合并只保留一层。
 */
import type {
  Api,
  AppSettings,
  ExtractionResult,
  LLMSettings,
  LLMTestResult,
  Project,
  RawInput,
  Requirement,
  RequirementPatch,
} from "../api";
import rules from "../generated/rules.json";
import {
  buildExtractionUserPrompt,
  buildLatentUserPrompt,
  combinePrompt,
  EXTRACT_PROMPT,
  EXTRACT_TASK,
  LATENT_PROMPT,
  LATENT_TASK,
  LIMITS,
  ModelOutputError,
  parseExtraction,
  parseHypotheses,
  subcategoryKeys,
} from "./analysis";
import { blankRequirement, type Persistence, type Stored } from "./persistence";

/** 调用模型。失败时抛出带中文说明的 Error。 */
export type LlmFunction = (prompt: string) => Promise<string>;

export interface LocalBackendOptions {
  version: string;
  /** 取得数据存放处。可以是异步的（在线版要等平台就绪）。 */
  persistence: () => Promise<Persistence>;
  /** 没有模型时传 null：录入的材料只按句子拆开，不做分析。 */
  llm: LlmFunction | null;
  /** 设置页和调用记录里显示的模型信息。 */
  llmInfo: { provider: LLMSettings["provider"]; label: string };
  /** 模拟一点延迟，让预览版的“正在分析”看得见。 */
  delayMs?: number;
}

class UserError extends Error {}

const INACTIVE = new Set(["rejected", "merged"]);

export function createLocalBackend(options: LocalBackendOptions): Api {
  const { llm } = options;
  let demoSettings: LLMSettings = {
    provider: options.llmInfo.provider,
    base_url: "",
    model: "",
    api_key_set: false,
    api_key_hint: "",
    source: "env",
  };

  async function settle<T>(value: T): Promise<T> {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    return structuredClone(value);
  }

  async function serialize(store: Persistence, stored: Stored[]): Promise<Requirement[]> {
    if (stored.length === 0) return [];
    const projectIds = [...new Set(stored.map((r) => r.project_id))];
    const all: Stored[] = [];
    const requesterOf = new Map<number, string>();
    for (const pid of projectIds) {
      all.push(...(await store.listRequirements(pid)));
      for (const input of await store.listInputs(pid)) requesterOf.set(input.id, input.requester);
    }
    return stored.map((r) => {
      const merged = all.filter((x) => x.status === "merged" && x.duplicate_of_id === r.id);
      const names = [r, ...merged]
        .map((x) => (x.input_id === null ? "" : (requesterOf.get(x.input_id) ?? "")))
        .filter(Boolean);
      return { ...r, mention_count: 1 + merged.length, requesters: [...new Set(names)].sort() };
    });
  }

  async function requireProject(store: Persistence, projectId: number): Promise<Project> {
    const project = (await store.listProjects()).find((p) => p.id === projectId);
    if (!project) throw new UserError("项目不存在");
    return project;
  }

  /** 调用模型并留下完整记录，成功失败都记。 */
  async function callModel(
    store: Persistence,
    meta: { task: string; version: string; project_id: number; input_id: number | null },
    system: string,
    user: string,
  ): Promise<string> {
    if (!llm) throw new UserError("没有可用的模型");
    const started = Date.now();
    let response: string | null = null;
    let error: string | null = null;
    try {
      response = await llm(combinePrompt(system, user));
      return response;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await store
        .logCall({
          project_id: meta.project_id,
          input_id: meta.input_id,
          task: meta.task,
          prompt_version: meta.version,
          provider: options.llmInfo.provider,
          model: options.llmInfo.label,
          request: { system, user },
          response,
          error,
          latency_ms: Date.now() - started,
          created_at: new Date().toISOString(),
        })
        // 记录写不进去不应该让分析失败。
        .catch(() => undefined);
    }
  }

  function splitSentences(input: RawInput, firstId: number): Stored[] {
    return input.content
      .split(/[。！？!?；;\n]+/)
      .map((s) => s.replace(/^[\s\-•·*]*(\d+[.、)）]\s*)?/, "").trim())
      .filter((s) => s.length >= 6)
      .map((s, i) => ({
        ...blankRequirement(),
        id: firstId + i,
        project_id: input.project_id,
        input_id: input.id,
        title: s.slice(0, 30),
        description: s,
        source_quote: s,
        quote_verified: true,
        stated_request: s,
        reasoning: "预览版没有接入模型，这里只是把材料按句子拆开，没有做分析。",
        priority_reason: "预览版未做优先级判断。",
      }));
  }

  async function extract(store: Persistence, input: RawInput): Promise<ExtractionResult> {
    let created: Stored[];
    if (!llm) {
      const count = input.content.split(/[。！？!?；;\n]+/).length;
      created = splitSentences(input, await store.reserveIds(count));
    } else {
      const project = await requireProject(store, input.project_id);
      const existing = (await store.listRequirements(input.project_id))
        .filter((r) => !INACTIVE.has(r.status))
        .sort((a, b) => b.id - a.id)
        .slice(0, LIMITS.max_existing)
        .map((r) => ({ id: r.id, title: r.title }));
      try {
        const text = await callModel(
          store,
          { task: EXTRACT_TASK, version: EXTRACT_PROMPT.version, project_id: project.id, input_id: input.id },
          EXTRACT_PROMPT.system,
          buildExtractionUserPrompt(input, existing, project.description),
        );
        const parsed = parseExtraction(text, input.content, new Set(existing.map((e) => e.id)));
        const firstId = parsed.length > 0 ? await store.reserveIds(parsed.length) : 0;
        created = parsed.map((fields, i) => ({
          ...blankRequirement(),
          ...(fields as Partial<Stored>),
          id: firstId + i,
          title: fields.title,
          project_id: input.project_id,
          input_id: input.id,
        }));
      } catch (err) {
        // 材料已经保存，分析失败时标记出来，可以重试。
        const failed: RawInput = {
          ...input,
          status: "failed",
          error: err instanceof Error ? err.message : "原因未知",
        };
        await store.saveInput(failed);
        return { input: failed, requirements: [] };
      }
    }
    await store.saveRequirements(created);
    const processed: RawInput = { ...input, status: "processed", error: null };
    await store.saveInput(processed);
    return { input: processed, requirements: await serialize(store, created) };
  }

  const api: Api = {
    health: async () => {
      const store = await options.persistence();
      return settle({
        version: options.version,
        status: "ok",
        llm_provider: options.llmInfo.provider,
        llm_model: llm ? options.llmInfo.label : "",
        demo_mode: llm === null,
        ...(store.durable || llm === null
          ? {}
          : { warning: "现在连不上这个页面的数据存储，录入的内容在刷新后会丢失。请确认已在 Claude 里登录，然后重新打开页面。" }),
      });
    },

    getSettings: () =>
      settle<AppSettings>({
        version: options.version,
        llm: llm
          ? { provider: options.llmInfo.provider, base_url: "", model: options.llmInfo.label, api_key_set: false, api_key_hint: "", source: "env" }
          : demoSettings,
      }),

    saveLlmSettings: async (body) => {
      if (llm) throw new Error("在线版由页面直接调用模型，不需要配置。");
      if (body.provider === "openai_compatible") {
        if (!/^https?:\/\//i.test(body.base_url.trim())) throw new Error("接口地址要以 http:// 或 https:// 开头");
        if (!body.model.trim()) throw new Error("请填写模型名称");
      }
      // 预览版不保存密钥本身，只记住“填过”和末四位，用来演示界面。
      const key = body.api_key;
      demoSettings = {
        provider: body.provider,
        base_url: body.base_url.trim().replace(/\/+$/, ""),
        model: body.model.trim(),
        api_key_set: key === null ? demoSettings.api_key_set : key.trim() !== "",
        api_key_hint:
          key === null ? demoSettings.api_key_hint : key.trim().length >= 12 ? `…${key.trim().slice(-4)}` : "",
        source: "settings",
      };
      return settle(demoSettings);
    },

    testLlm: async (): Promise<LLMTestResult> => {
      if (!llm) {
        return settle(
          demoSettings.provider === "mock"
            ? { ok: true, latency_ms: 0, message: "演示模式不调用模型，无需测试。" }
            : {
                ok: false,
                latency_ms: 0,
                message: "预览版不能连接模型。在你自己的电脑上运行完整版后，这里会真正向模型发一句话。",
              },
        );
      }
      const started = Date.now();
      try {
        const reply = await llm("你在做连通性测试。请只回复两个字：正常");
        return { ok: true, latency_ms: Date.now() - started, message: `连接成功，模型回复：${reply.trim().slice(0, 50)}` };
      } catch (err) {
        return {
          ok: false,
          latency_ms: Date.now() - started,
          message: err instanceof Error ? err.message : "原因未知",
        };
      }
    },

    appeals: () => settle(rules.appeals as never),
    classification: () => settle(rules.classification as never),

    listProjects: async () => settle(await (await options.persistence()).listProjects()),

    createProject: async (name) => {
      const store = await options.persistence();
      const project: Project = {
        id: await store.reserveIds(1),
        name: name.trim(),
        description: "",
        dismissed_probes: [],
      };
      if (!project.name) throw new Error("项目名称不能为空");
      await store.saveProject(project);
      return settle(project);
    },

    updateProject: async (projectId, patch) => {
      const store = await options.persistence();
      const project = { ...(await requireProject(store, projectId)), ...patch };
      if (typeof patch.name === "string") project.name = patch.name.trim();
      if (typeof patch.description === "string") project.description = patch.description.trim();
      if (!project.name) throw new Error("项目名称不能为空");
      await store.saveProject(project);
      return settle(project);
    },

    listRequirements: async (projectId) => {
      const store = await options.persistence();
      const stored = (await store.listRequirements(projectId)).sort((a, b) => b.id - a.id);
      return settle(await serialize(store, stored));
    },

    listInputs: async (projectId) => settle(await (await options.persistence()).listInputs(projectId)),

    submitInput: async (projectId, content, sourceType, requester) => {
      const store = await options.persistence();
      await requireProject(store, projectId);
      if (!content.trim()) throw new Error("材料内容不能为空");
      const input: RawInput = {
        id: await store.reserveIds(1),
        project_id: projectId,
        source_type: sourceType.trim(),
        requester: requester.trim(),
        content,
        status: "pending",
        error: null,
        created_at: new Date().toISOString(),
      };
      await store.saveInput(input);
      return settle(await extract(store, input));
    },

    retryExtraction: async (inputId) => {
      const store = await options.persistence();
      const input = await store.getInput(inputId);
      if (!input) throw new Error("材料不存在");
      if (input.status === "processed") throw new Error("这份材料已经提取过，重复提取会产生重复需求");
      return settle(await extract(store, input));
    },

    discoverLatentNeeds: async (projectId) => {
      const store = await options.persistence();
      const project = await requireProject(store, projectId);
      const active = (await store.listRequirements(projectId))
        .filter((r) => !INACTIVE.has(r.status))
        .sort((a, b) => b.id - a.id)
        .slice(0, LIMITS.max_requirements_for_latent);
      const stated = active.filter((r) => r.kind === "stated");
      if (stated.length < LIMITS.min_requirements_for_latent) {
        throw new Error(
          `至少需要 ${LIMITS.min_requirements_for_latent} 条未否决的客户需求才能分析潜在需求，目前只有 ${stated.length} 条。`,
        );
      }
      // 没有模型时给不出新的假设。
      if (!llm) return settle({ requirements: [], dropped_without_basis: 0 });

      let parsed;
      try {
        const text = await callModel(
          store,
          { task: LATENT_TASK, version: LATENT_PROMPT.version, project_id: projectId, input_id: null },
          LATENT_PROMPT.system,
          buildLatentUserPrompt(
            stated,
            active.filter((r) => r.kind === "latent").map((r) => r.title),
            project.description,
          ),
        );
        parsed = parseHypotheses(text, new Set(stated.map((r) => r.id)));
      } catch (err) {
        const reason = err instanceof Error ? err.message : "原因未知";
        throw new Error(err instanceof ModelOutputError ? `分析失败：${reason}` : reason);
      }
      const firstId = parsed.items.length > 0 ? await store.reserveIds(parsed.items.length) : 0;
      const created: Stored[] = parsed.items.map((fields, i) => ({
        ...blankRequirement(),
        ...(fields as Partial<Stored>),
        id: firstId + i,
        title: fields.title,
        project_id: projectId,
      }));
      await store.saveRequirements(created);
      return settle({
        requirements: await serialize(store, created),
        dropped_without_basis: parsed.dropped,
      });
    },

    mergeRequirement: async (reqId, targetId) => {
      const store = await options.persistence();
      const source = await store.getRequirement(reqId);
      const target = await store.getRequirement(targetId);
      if (!source || !target) throw new Error("需求不存在");
      if (source.id === target.id) throw new Error("不能并入自己");
      if (source.project_id !== target.project_id) throw new Error("只能并入同一个项目里的需求");
      if (source.kind !== "stated" || target.kind !== "stated") throw new Error("只有客户提出的需求可以合并");
      if (source.status === "merged") throw new Error("这条需求已经并入别的需求");
      if (INACTIVE.has(target.status)) throw new Error("目标需求已被合并或否决，不能再并入");
      // 之前并入这条需求的，一起转到新的目标上，保持只有一层。
      const children = (await store.listRequirements(source.project_id))
        .filter((r) => r.status === "merged" && r.duplicate_of_id === source.id)
        .map((r) => ({ ...r, duplicate_of_id: target.id }));
      const merged: Stored = { ...source, status: "merged", duplicate_of_id: target.id };
      await store.saveRequirements([...children, merged]);
      const [mergedOut, targetOut] = await serialize(store, [merged, target]);
      return settle({ merged: mergedOut, target: targetOut });
    },

    updateRequirement: async (reqId, patch: RequirementPatch) => {
      const store = await options.persistence();
      const current = await store.getRequirement(reqId);
      if (!current) throw new Error("需求不存在");
      const next: Stored = { ...current, ...patch };
      if (patch.title !== undefined) {
        next.title = patch.title.trim();
        if (!next.title) throw new Error("标题不能为空");
      }
      if (patch.open_questions) {
        next.open_questions = patch.open_questions.map((q) => q.trim()).filter(Boolean);
      }
      // 类别变了而子类没跟着传时，原来的子类不再适用。
      if (next.subcategory !== null && !subcategoryKeys(next.category).has(next.subcategory)) {
        if (patch.subcategory) throw new Error("这个子类不属于所选的需求类别");
        next.subcategory = null;
      }
      // 确认过的需求必须有去向，否则确认之后就没有下文了。
      if (
        next.status === "confirmed" &&
        next.disposition === "undecided" &&
        ("status" in patch || "disposition" in patch)
      ) {
        throw new Error("确认前请先选定这条需求的去向");
      }
      // 潜在需求是假设，没有向客户验证成立之前不能当作正式需求。
      if (next.kind === "latent" && next.status === "confirmed" && next.validation_status !== "validated") {
        throw new Error("潜在需求必须先向客户验证成立，才能确认");
      }
      await store.saveRequirements([next]);
      const [out] = await serialize(store, [next]);
      return settle(out);
    },
  };
  return api;
}
