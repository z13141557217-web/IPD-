/**
 * 预览版用的假后端：数据放在浏览器内存里，刷新后恢复原样。
 *
 * 用途是让人不装任何东西就能点开界面看流程。它不做任何分析：
 * 示例需求里的分析内容是手写的，新录入的材料只按句子拆开。
 * 业务规则（确认前要有去向、假设要先验证、合并）与真实后端保持一致。
 */
import type {
  Api,
  AppSettings,
  ExtractionResult,
  LLMSettings,
  Project,
  RawInput,
  Requirement,
  RequirementPatch,
} from "../api";
import rules from "./rules.json";

const VERSION = `${__APP_VERSION__}（预览）`;

type Stored = Omit<Requirement, "mention_count" | "requesters">;

let nextId = 100;
const id = () => nextId++;

const projects: Project[] = [
  {
    id: 1,
    name: "智能门锁（示例）",
    description: "客户是连锁长租公寓运营商，一名管家负责约两百间房的门锁，租客流动频繁。",
    dismissed_probes: [],
  },
];

const inputs: RawInput[] = [
  {
    id: 1,
    project_id: 1,
    source_type: "客户",
    requester: "城南公寓",
    content:
      "门锁开机太慢，指纹识别要等两秒。\n报价比竞品高了一成，希望能给折扣。\n安装说明书看不懂，师傅上门装了一个小时。\n售后响应慢，报修三天没人管。",
    status: "processed",
    error: null,
    created_at: "2026-10-01T09:00:00Z",
  },
  {
    id: 2,
    project_id: 1,
    source_type: "客户",
    requester: "城北公寓",
    content: "指纹开锁慢得受不了。",
    status: "processed",
    error: null,
    created_at: "2026-10-03T09:00:00Z",
  },
];

function make(partial: Partial<Stored> & Pick<Stored, "id" | "title">): Stored {
  return {
    project_id: 1,
    input_id: 1,
    description: "",
    source_quote: "",
    quote_verified: true,
    appeals: null,
    priority: "medium",
    priority_reason: "",
    kind: "stated",
    category: "unknown",
    subcategory: null,
    disposition: "undecided",
    disposition_reason: "",
    reject_reason: "",
    demand_type: "unknown",
    stated_request: "",
    underlying_problem: "",
    reasoning: "",
    confidence: "low",
    open_questions: [],
    based_on: [],
    validation_plan: "",
    validation_status: "unverified",
    status: "draft",
    duplicate_of_id: null,
    ...partial,
  };
}

const requirements: Stored[] = [
  make({
    id: 1,
    title: "走到门口伸手即开，无需停顿",
    description: "住户希望开门是一个连贯动作，不需要停下来等锁反应。",
    source_quote: "门锁开机太慢，指纹识别要等两秒",
    stated_request: "希望指纹识别快一点",
    underlying_problem: "住户到门口时手里常提着东西，等待的两秒里门锁没有任何反馈，会怀疑没识别上而重复按压。",
    reasoning: "材料只说了等两秒，没有说明场景。提东西、重复按压是按常见情况推测的，需要向客户确认。",
    confidence: "medium",
    open_questions: ["等待的两秒里，用户通常会做什么？会重复按吗？", "慢是每次都慢，还是隔一段时间不用后才慢？"],
    demand_type: "strategic",
    category: "quality",
    subcategory: "performance",
    disposition: "next",
    disposition_reason: "影响每天使用，但需要改识别方案，赶不上当前版本。",
    appeals: "performance",
    priority: "high",
    priority_reason: "客户首先提到，且直接影响每天的使用。",
  }),
  make({
    id: 2,
    title: "让客户看得到价差对应的价值",
    description: "客户需要一个能向内部交代的理由，说明为什么值得多付一成。",
    source_quote: "报价比竞品高了一成，希望能给折扣",
    stated_request: "希望给折扣",
    underlying_problem: "客户没有看到与多出的一成价格相对应的价值，所以只能在价格上比较。",
    reasoning: "客户拿竞品报价作比较，说明在他看来两者差不多。降价只是其中一种解法。",
    confidence: "low",
    open_questions: ["对比的是哪家竞品的哪个型号？", "如果价格不变，增加什么会让你愿意接受？"],
    demand_type: "project",
    category: "functional",
    appeals: "price",
    priority_reason: "影响成交，但材料没有说明是否因此丢单。",
  }),
  make({
    id: 3,
    title: "安装师傅第一次装也能快速装对",
    description: "不依赖师傅经验，安装时间可预期。",
    source_quote: "安装说明书看不懂，师傅上门装了一个小时",
    stated_request: "说明书要写得让人看懂",
    underlying_problem: "安装依赖师傅的个人经验，耗时不可控，客户要承担等待时间和上门费用。",
    reasoning: "材料直接给出了后果：装了一个小时。问题不在说明书的文字，而在安装过程本身容易出错。",
    confidence: "high",
    demand_type: "strategic",
    category: "quality",
    subcategory: "maintainability",
    disposition: "current",
    disposition_reason: "已经在增加上门成本，改安装引导即可。",
    appeals: "ease_of_use",
    priority: "high",
    priority_reason: "材料明确描述了耗时后果。",
    status: "confirmed",
  }),
  make({
    id: 4,
    title: "锁出故障时当天能恢复正常进出",
    description: "客户要的是尽快恢复使用，而不只是有人接电话。",
    source_quote: "售后响应慢，报修三天没人管",
    stated_request: "售后响应要快",
    underlying_problem: "门锁出故障意味着进不了家门或门锁不上，客户等不起三天。",
    reasoning: "门锁是进出家门的必经环节，故障的后果比一般家电严重。材料没有说明具体是什么故障。",
    confidence: "medium",
    open_questions: ["报修的是什么故障？当时还能正常开关门吗？"],
    category: "quality",
    subcategory: "reliability",
    disposition: "current",
    disposition_reason: "涉及进出家门，不能拖。",
    appeals: "assurances",
    priority: "high",
    priority_reason: "涉及安全和基本使用。",
  }),
  make({
    id: 5,
    input_id: 2,
    title: "开门不需要等待",
    description: "开锁动作要连贯。",
    source_quote: "指纹开锁慢得受不了",
    stated_request: "希望开锁快一点",
    underlying_problem: "租客在门口等待，体验差。",
    reasoning: "与已有的一条需求说的是同一件事。",
    confidence: "high",
    demand_type: "strategic",
    category: "quality",
    subcategory: "performance",
    disposition: "next",
    disposition_reason: "同已有需求。",
    appeals: "performance",
    priority: "high",
    priority_reason: "第二家客户也在提。",
    duplicate_of_id: 1,
  }),
  make({
    id: 6,
    input_id: null,
    kind: "latent",
    title: "锁在出问题之前先提醒，并能自行恢复",
    description: "住户不想等到进不了门才发现问题。",
    based_on: [4, 3],
    reasoning: "售后慢和安装难都发生在需要人上门的环节。客户抱怨的是上门慢，但更根本的是他不希望落到需要上门的地步。",
    validation_plan: "回访 5 位报修过的客户，问故障发生前有没有征兆、如果提前收到提醒会怎么做。",
    open_questions: ["故障前有没有电量低、反应变慢之类的征兆？"],
    category: "quality",
    subcategory: "reliability",
    appeals: "assurances",
    priority_reason: "依据来自两条高优先级需求，但尚未验证。",
    quote_verified: false,
  }),
];

let llm: LLMSettings = {
  provider: "mock",
  base_url: "",
  model: "",
  api_key_set: false,
  api_key_hint: "",
  source: "env",
};

function respond<T>(value: T, ms = 200): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));
}

function fail(message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 150));
}

function serialize(r: Stored): Requirement {
  const merged = requirements.filter((x) => x.status === "merged" && x.duplicate_of_id === r.id);
  const names = [r, ...merged]
    .map((x) => inputs.find((i) => i.id === x.input_id)?.requester ?? "")
    .filter(Boolean);
  return { ...r, mention_count: 1 + merged.length, requesters: [...new Set(names)].sort() };
}

function find(reqId: number): Stored | undefined {
  return requirements.find((r) => r.id === reqId);
}

function subcategoriesOf(category: string): string[] {
  if (category === "quality") return rules.classification.quality_attributes.map((q) => q.key);
  if (category === "constraint") return rules.classification.constraints.map((c) => c.key);
  return [];
}

function splitSentences(input: RawInput): Stored[] {
  return input.content
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.replace(/^[\s\-•·*]*(\d+[.、)）]\s*)?/, "").trim())
    .filter((s) => s.length >= 6)
    .map((s) =>
      make({
        id: id(),
        project_id: input.project_id,
        input_id: input.id,
        title: s.slice(0, 30),
        description: s,
        source_quote: s,
        stated_request: s,
        reasoning: "预览版没有接入模型，这里只是把材料按句子拆开，没有做分析。",
        priority_reason: "预览版未做优先级判断。",
      }),
    );
}

export const demoApi: Api = {
  health: () =>
    respond({
      version: VERSION,
      status: "ok",
      llm_provider: llm.provider,
      llm_model: llm.provider === "mock" ? "" : llm.model,
      demo_mode: llm.provider === "mock",
    }),

  getSettings: () => respond<AppSettings>({ version: VERSION, llm }),

  saveLlmSettings: (body) => {
    if (body.provider === "openai_compatible") {
      if (!/^https?:\/\//i.test(body.base_url.trim())) return fail("接口地址要以 http:// 或 https:// 开头");
      if (!body.model.trim()) return fail("请填写模型名称");
    }
    // 预览版不保存密钥本身，只记住“填过”和末四位，用来演示界面。
    const key = body.api_key;
    llm = {
      provider: body.provider,
      base_url: body.base_url.trim().replace(/\/+$/, ""),
      model: body.model.trim(),
      api_key_set: key === null ? llm.api_key_set : key.trim() !== "",
      api_key_hint: key === null ? llm.api_key_hint : key.trim().length >= 12 ? `…${key.trim().slice(-4)}` : "",
      source: "settings",
    };
    return respond(llm);
  },

  testLlm: () =>
    respond(
      llm.provider === "mock"
        ? { ok: true, latency_ms: 0, message: "演示模式不调用模型，无需测试。" }
        : {
            ok: false,
            latency_ms: 0,
            message: "预览版不能连接模型。在你自己的电脑上运行完整版后，这里会真正向模型发一句话。",
          },
    ),

  appeals: () => respond(rules.appeals as never),
  classification: () => respond(rules.classification as never),

  listProjects: () => respond(projects),

  createProject: (name) => {
    const project: Project = { id: id(), name, description: "", dismissed_probes: [] };
    projects.unshift(project);
    return respond(project);
  },

  updateProject: (projectId, patch) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return fail("项目不存在");
    Object.assign(project, patch);
    return respond(project);
  },

  listRequirements: (projectId) =>
    respond(
      requirements
        .filter((r) => r.project_id === projectId)
        .sort((a, b) => b.id - a.id)
        .map(serialize),
    ),

  listInputs: (projectId) => respond(inputs.filter((i) => i.project_id === projectId)),

  submitInput: (projectId, content, sourceType, requester) => {
    const input: RawInput = {
      id: id(),
      project_id: projectId,
      source_type: sourceType,
      requester: requester.trim(),
      content,
      status: "processed",
      error: null,
      created_at: new Date().toISOString(),
    };
    inputs.push(input);
    const created = splitSentences(input);
    requirements.push(...created);
    return respond<ExtractionResult>({ input, requirements: created.map(serialize) }, 700);
  },

  retryExtraction: () => fail("预览版里没有需要重试的材料"),

  discoverLatentNeeds: (projectId) => {
    const stated = requirements.filter(
      (r) => r.project_id === projectId && r.kind === "stated" && r.status !== "rejected" && r.status !== "merged",
    );
    if (stated.length < 3) {
      return fail(`至少需要 3 条未否决的客户需求才能分析潜在需求，目前只有 ${stated.length} 条。`);
    }
    // 预览版没有模型，给不出新的假设；示例项目里已经放了一条手写的。
    return respond({ requirements: [], dropped_without_basis: 0 }, 700);
  },

  mergeRequirement: (reqId, targetId) => {
    const source = find(reqId);
    const target = find(targetId);
    if (!source || !target) return fail("需求不存在");
    if (source.id === target.id) return fail("不能并入自己");
    if (source.kind !== "stated" || target.kind !== "stated") return fail("只有客户提出的需求可以合并");
    if (source.status === "merged") return fail("这条需求已经并入别的需求");
    if (target.status === "merged" || target.status === "rejected") {
      return fail("目标需求已被合并或否决，不能再并入");
    }
    requirements
      .filter((r) => r.status === "merged" && r.duplicate_of_id === source.id)
      .forEach((r) => (r.duplicate_of_id = target.id));
    source.status = "merged";
    source.duplicate_of_id = target.id;
    return respond({ merged: serialize(source), target: serialize(target) });
  },

  updateRequirement: (reqId, patch: RequirementPatch) => {
    const current = find(reqId);
    if (!current) return fail("需求不存在");
    const next: Stored = { ...current, ...patch };
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.open_questions) next.open_questions = patch.open_questions.map((q) => q.trim()).filter(Boolean);

    if (next.subcategory !== null && !subcategoriesOf(next.category).includes(next.subcategory)) {
      if (patch.subcategory) return fail("这个子类不属于所选的需求类别");
      next.subcategory = null;
    }
    if (
      next.status === "confirmed" &&
      next.disposition === "undecided" &&
      ("status" in patch || "disposition" in patch)
    ) {
      return fail("确认前请先选定这条需求的去向");
    }
    if (next.kind === "latent" && next.status === "confirmed" && next.validation_status !== "validated") {
      return fail("潜在需求必须先向客户验证成立，才能确认");
    }
    Object.assign(current, next);
    return respond(serialize(current));
  },
};
