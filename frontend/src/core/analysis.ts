/**
 * 在线版在浏览器里做的两件事：拼提示词、解析模型输出。
 *
 * 这里的每个函数都对应后端的一个函数（backend/app/services/extraction.py、latent.py、
 * parsing.py），行为必须一致。analysis.test.ts 用后端算出的标准答案（generated/parity.json）
 * 来检查。改这里之前先改后端，再运行 scripts/export_rules.py。
 */
import rules from "../generated/rules.json";

export class ModelOutputError extends Error {}

const appealsKeys = new Set(rules.appeals.dimensions.map((d) => d.key));
const priorityKeys = new Set(rules.appeals.priorities.map((p) => p.key));
const categoryKeys = new Set(rules.classification.categories.map((c) => c.key));
const dispositionKeys = new Set(rules.classification.dispositions.map((d) => d.key));
const confidenceLevels = new Set(["high", "medium", "low"]);
const demandTypes = new Set(["strategic", "project", "unknown"]);

export function subcategoryKeys(category: string | null): Set<string> {
  if (category === "quality") return new Set(rules.classification.quality_attributes.map((q) => q.key));
  if (category === "constraint") return new Set(rules.classification.constraints.map((c) => c.key));
  return new Set();
}

// ---- 与后端 parsing.py 对应的小工具 ----

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadJsonObject(text: string): Dict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ModelOutputError("模型输出中没有 JSON 对象");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new ModelOutputError(`模型输出不是合法的 JSON：${err instanceof Error ? err.message : err}`);
  }
  if (!isDict(data)) throw new ModelOutputError("模型输出不是 JSON 对象");
  return data;
}

function getList(data: Dict, key: string): unknown[] {
  const items = data[key];
  if (!Array.isArray(items)) throw new ModelOutputError(`模型输出缺少 ${key} 列表`);
  return items;
}

function textOf(item: Dict, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function knownId(value: unknown, known: Set<number>): number | null {
  return typeof value === "number" && Number.isInteger(value) && known.has(value) ? value : null;
}

function choice<T extends string | null>(value: unknown, allowed: Set<string>, fallback: T): string | T {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 按字符（而不是 UTF-16 单元）截断，和 Python 的切片一致。 */
function truncate(text: string, length: number): string {
  return [...text].slice(0, length).join("");
}

/** 和 Python 的 json.dumps(value, ensure_ascii=False) 输出相同的格式（逗号和冒号后有空格）。 */
export function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (isDict(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

// ---- 提取需求 ----

export const EXTRACT_TASK = "extract_requirements";
export const EXTRACT_PROMPT = rules.prompts.extract_requirements;

function dimensionLines(): string {
  return rules.appeals.dimensions.map((d) => `- ${d.key}（${d.name}）：${d.description}`).join("\n");
}

function classificationBlock(): string {
  const c = rules.classification;
  const quality = c.quality_attributes.map((q) => `  - ${q.key}（${q.name}）：${q.description}`).join("\n");
  const constraints = c.constraints.map((x) => `  - ${x.key}（${x.name}）`).join("\n");
  const dispositions = c.dispositions.map((d) => `- ${d.key}（${d.name}）：${d.description}`).join("\n");
  return (
    `<分类>\n质量属性：\n${quality}\n设计约束：\n${constraints}\n</分类>\n\n` +
    `<去向>\n${dispositions}\n</去向>\n\n`
  );
}

function backgroundBlock(background: string): string {
  return `<项目背景>\n${background.trim() || "（未填写）"}\n</项目背景>\n\n`;
}

function clean(text: string): string {
  return text.replace(/[<>"\n]/g, "") || "未注明";
}

export interface ExistingRequirement {
  id: number;
  title: string;
}

export function buildExtractionUserPrompt(
  input: { source_type: string; requester: string; content: string },
  existing: ExistingRequirement[],
  background: string,
): string {
  return (
    backgroundBlock(background) +
    classificationBlock() +
    `<维度>\n${dimensionLines()}\n</维度>\n\n` +
    `<已有需求>\n${pyJson(existing)}\n</已有需求>\n\n` +
    `<材料 来源="${clean(input.source_type)}" 提出者="${clean(input.requester)}">\n${input.content}\n</材料>`
  );
}

export interface ExtractedFields {
  kind: "stated";
  title: string;
  description: string;
  stated_request: string;
  underlying_problem: string;
  reasoning: string;
  confidence: string;
  demand_type: string;
  category: string;
  subcategory: string | null;
  disposition: string;
  disposition_reason: string;
  open_questions: string[];
  source_quote: string;
  quote_verified: boolean;
  appeals: string | null;
  priority: string;
  priority_reason: string;
  duplicate_of_id: number | null;
}

export function parseExtraction(text: string, content: string, existingIds: Set<number>): ExtractedFields[] {
  const items = getList(loadJsonObject(text), "requirements");
  const normalizedContent = normalize(content);
  const results: ExtractedFields[] = [];
  for (const item of items) {
    if (!isDict(item)) continue;
    const title = textOf(item, "title");
    if (!title) continue;
    const category = choice(item.category, categoryKeys, "unknown");
    const quote = textOf(item, "source_quote");
    const normalizedQuote = normalize(quote);
    results.push({
      kind: "stated",
      title: truncate(title, 300),
      description: textOf(item, "description"),
      stated_request: textOf(item, "stated_request"),
      underlying_problem: textOf(item, "underlying_problem"),
      reasoning: textOf(item, "reasoning"),
      // 模型没有给出合法的把握程度时按最低处理，宁可多核对。
      confidence: choice(item.confidence, confidenceLevels, "low"),
      demand_type: choice(item.demand_type, demandTypes, "unknown"),
      category,
      // 子类必须属于所选类别，否则丢弃子类，保留类别。
      subcategory: choice(item.subcategory, subcategoryKeys(category), null),
      disposition: choice(item.disposition, dispositionKeys, "undecided"),
      disposition_reason: textOf(item, "disposition_reason"),
      open_questions: textList(item.open_questions),
      source_quote: quote,
      // 依据必须能在原始材料里逐字找到，否则标记为未核实，由界面提示用户。
      quote_verified: Boolean(normalizedQuote) && normalizedContent.includes(normalizedQuote),
      appeals: choice(item.appeals, appealsKeys, null),
      priority: choice(item.priority, priorityKeys, "medium"),
      priority_reason: textOf(item, "priority_reason"),
      duplicate_of_id: knownId(item.duplicate_of, existingIds),
    });
  }
  return results;
}

// ---- 发现潜在需求 ----

export const LATENT_TASK = "discover_latent_needs";
export const LATENT_PROMPT = rules.prompts.discover_latent_needs;
export const LIMITS = rules.limits;

export interface StatedForLatent {
  id: number;
  title: string;
  stated_request: string;
  underlying_problem: string;
  source_quote: string;
}

export function buildLatentUserPrompt(
  stated: StatedForLatent[],
  existingLatent: string[],
  background: string,
): string {
  const items = stated.map((r) => ({
    id: r.id,
    title: r.title,
    stated_request: r.stated_request,
    underlying_problem: r.underlying_problem,
    source_quote: r.source_quote,
  }));
  return (
    `<项目背景>\n${background.trim() || "（未填写）"}\n</项目背景>\n\n` +
    `<维度>\n${dimensionLines()}\n</维度>\n\n` +
    `<已有假设>\n${pyJson(existingLatent)}\n</已有假设>\n\n` +
    `<需求清单>\n${pyJson(items)}\n</需求清单>`
  );
}

export interface HypothesisFields {
  kind: "latent";
  title: string;
  description: string;
  based_on: number[];
  reasoning: string;
  validation_plan: string;
  open_questions: string[];
  validation_status: "unverified";
  confidence: "low";
  appeals: string | null;
  priority: string;
  priority_reason: string;
}

export function parseHypotheses(
  text: string,
  knownIds: Set<number>,
): { items: HypothesisFields[]; dropped: number } {
  const list = getList(loadJsonObject(text), "hypotheses");
  const items: HypothesisFields[] = [];
  let dropped = 0;
  for (const item of list) {
    if (!isDict(item)) continue;
    const title = textOf(item, "title");
    if (!title) continue;
    const basis: number[] = [];
    for (const value of Array.isArray(item.based_on) ? item.based_on : []) {
      const rid = knownId(value, knownIds);
      if (rid !== null && !basis.includes(rid)) basis.push(rid);
    }
    if (basis.length === 0) {
      // 没有指向任何真实存在的需求，就是没有依据的想象，不入库。
      dropped += 1;
      continue;
    }
    items.push({
      kind: "latent",
      title: truncate(title, 300),
      description: textOf(item, "description"),
      based_on: basis,
      reasoning: textOf(item, "reasoning"),
      validation_plan: textOf(item, "validation_plan"),
      open_questions: textList(item.open_questions),
      validation_status: "unverified",
      confidence: "low",
      appeals: choice(item.appeals, appealsKeys, null),
      priority: choice(item.priority, priorityKeys, "medium"),
      priority_reason: textOf(item, "priority_reason"),
    });
    if (items.length >= rules.limits.max_hypotheses) break;
  }
  return { items, dropped };
}

/**
 * 在线版的模型接口没有单独的“系统提示”，所以把指令和数据拼成一段。
 * 指令在前，数据在后，中间用一行说明隔开。
 */
export function combinePrompt(system: string, user: string): string {
  return `${system}\n\n以下是这次要处理的数据：\n\n${user}`;
}
