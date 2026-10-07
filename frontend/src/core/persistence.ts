/**
 * 在线版和预览版的数据存放。
 *
 * 两种实现：
 * - MemoryPersistence：放在页面内存里，刷新即丢。预览版用它；在线版连不上存储时也退回到它。
 * - DbPersistence：放在发布平台为这个页面提供的文档存储里，刷新、换设备后都还在。
 */
import type { Project, RawInput, Requirement } from "../api";

/** 存下来的需求。“几处提到、来自谁”是读取时算出来的，不存。 */
export type Stored = Omit<Requirement, "mention_count" | "requesters">;

export interface LlmCallRecord {
  project_id: number | null;
  input_id: number | null;
  task: string;
  prompt_version: string;
  provider: string;
  model: string;
  request: { system: string; user: string };
  response: string | null;
  error: string | null;
  latency_ms: number;
  created_at: string;
}

export interface Persistence {
  /** 数据是否会保留。false 时界面要提醒使用者。 */
  readonly durable: boolean;
  listProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<void>;
  /** 删除项目，连同它的材料、需求和模型调用记录。 */
  deleteProject(projectId: number): Promise<void>;
  listInputs(projectId: number): Promise<RawInput[]>;
  getInput(id: number): Promise<RawInput | null>;
  saveInput(input: RawInput): Promise<void>;
  listRequirements(projectId: number): Promise<Stored[]>;
  getRequirement(id: number): Promise<Stored | null>;
  saveRequirements(requirements: Stored[]): Promise<void>;
  /** 预留 count 个连续的编号，返回第一个。 */
  reserveIds(count: number): Promise<number>;
  logCall(call: LlmCallRecord): Promise<void>;
}

export function blankRequirement(): Omit<Stored, "id" | "title" | "project_id"> {
  return {
    input_id: null,
    description: "",
    source_quote: "",
    quote_verified: false,
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
  };
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryPersistence implements Persistence {
  readonly durable = false;
  private projects: Project[];
  private inputs: RawInput[];
  private requirements: Stored[];
  private nextId: number;
  readonly calls: LlmCallRecord[] = [];

  constructor(seed?: { projects: Project[]; inputs: RawInput[]; requirements: Stored[] }) {
    this.projects = clone(seed?.projects ?? []);
    this.inputs = clone(seed?.inputs ?? []);
    this.requirements = clone(seed?.requirements ?? []);
    const ids = [...this.projects, ...this.inputs, ...this.requirements].map((x) => x.id);
    this.nextId = Math.max(100, ...ids.map((n) => n + 1));
  }

  async listProjects() {
    return clone(this.projects).sort((a, b) => b.id - a.id);
  }
  async saveProject(project: Project) {
    this.projects = [...this.projects.filter((p) => p.id !== project.id), clone(project)];
  }
  async deleteProject(projectId: number) {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.inputs = this.inputs.filter((i) => i.project_id !== projectId);
    this.requirements = this.requirements.filter((r) => r.project_id !== projectId);
    const kept = this.calls.filter((c) => c.project_id !== projectId);
    this.calls.length = 0;
    this.calls.push(...kept);
  }
  async listInputs(projectId: number) {
    return clone(this.inputs.filter((i) => i.project_id === projectId));
  }
  async getInput(id: number) {
    return clone(this.inputs.find((i) => i.id === id) ?? null);
  }
  async saveInput(input: RawInput) {
    this.inputs = [...this.inputs.filter((i) => i.id !== input.id), clone(input)];
  }
  async listRequirements(projectId: number) {
    return clone(this.requirements.filter((r) => r.project_id === projectId));
  }
  async getRequirement(id: number) {
    return clone(this.requirements.find((r) => r.id === id) ?? null);
  }
  async saveRequirements(requirements: Stored[]) {
    const ids = new Set(requirements.map((r) => r.id));
    this.requirements = [...this.requirements.filter((r) => !ids.has(r.id)), ...clone(requirements)];
  }
  async reserveIds(count: number) {
    const first = this.nextId;
    this.nextId += count;
    return first;
  }
  async logCall(call: LlmCallRecord) {
    this.calls.push(clone(call));
  }
}

// ---- 发布平台的文档存储 ----

interface DocSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  /** 短时间的互斥锁：同一时间只有一个持有者能拿到。 */
  acquire?(options: { holder: string; ttlMs?: number }): Promise<{ acquired: boolean }>;
}
interface Query {
  where(field: string, op: string, value: unknown): Query;
  limit(n: number): Query;
  get(): Promise<{ docs: DocSnapshot[] }>;
}
interface CollectionRef extends Query {
  doc(id?: string): DocRef;
  add(data: Record<string, unknown>): Promise<unknown>;
}
export interface DocStore {
  doc(path: string): DocRef;
  collection(path: string): CollectionRef;
}

const DB_MESSAGES: Record<string, string> = {
  quota_exceeded: "这个页面的存储空间已满，需要先清理一些旧数据。",
  resource_exhausted: "操作太频繁，请稍等几秒再试。",
  revoked: "这个页面的数据访问权限已被收回，请重新打开页面。",
  not_granted: "这个页面没有获得保存数据的权限。",
  invalid_argument: "数据没有保存成功。你可能只有查看权限，或数据格式有问题。",
};

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "";
    if (code === "unavailable") {
      // 平台的说明：这类错误是暂时的，隔一小会儿重试一次。
      await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 400));
      try {
        return await action();
      } catch {
        throw new Error("暂时连不上数据存储，请稍后再试。");
      }
    }
    throw new Error(DB_MESSAGES[code] ?? "数据存储出错，请稍后再试。");
  }
}

/** 文档存储只接受纯 JSON 对象，这里去掉 undefined 之类的值。 */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

// 一次最多读取的文档数，是平台允许的上限。
const PAGE = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DbPersistence implements Persistence {
  readonly durable = true;
  // 这个页面窗口的标识，用来在多个窗口之间争用编号计数器。
  private readonly holder = `tab-${Math.random().toString(36).slice(2)}`;
  // 同一个窗口里的取号请求排队执行，避免连点两下拿到同一个编号。
  private idQueue: Promise<unknown> = Promise.resolve();

  constructor(private db: DocStore) {}

  /** 删除某个集合里属于这个项目的全部文档。一次最多读一页，删完再读，直到读不到。 */
  private async deleteWhere(collection: string, projectId: number) {
    for (;;) {
      const snapshot = await guarded(() =>
        this.db.collection(collection).where("project_id", "==", projectId).limit(PAGE).get(),
      );
      if (snapshot.docs.length === 0) return;
      for (const doc of snapshot.docs) {
        await guarded(() => this.db.doc(`${collection}/${doc.id}`).delete());
      }
    }
  }

  async deleteProject(projectId: number) {
    // 先删项目下面的内容，最后删项目本身：中途失败时项目还在，可以再删一次。
    await this.deleteWhere("requirements", projectId);
    await this.deleteWhere("inputs", projectId);
    await this.deleteWhere("llm_calls", projectId);
    await guarded(() => this.db.doc(`projects/${projectId}`).delete());
  }

  private async list<T>(query: Query): Promise<T[]> {
    const snapshot = await guarded(() => query.limit(PAGE).get());
    return snapshot.docs.map((d) => clone(d.data()) as T);
  }

  private async read<T>(path: string): Promise<T | null> {
    const snapshot = await guarded(() => this.db.doc(path).get());
    return snapshot.exists ? (clone(snapshot.data()) as T) : null;
  }

  async listProjects() {
    return (await this.list<Project>(this.db.collection("projects"))).sort((a, b) => b.id - a.id);
  }
  async saveProject(project: Project) {
    await guarded(() => this.db.doc(`projects/${project.id}`).set(plain(project)));
  }
  listInputs(projectId: number) {
    return this.list<RawInput>(this.db.collection("inputs").where("project_id", "==", projectId));
  }
  getInput(id: number) {
    return this.read<RawInput>(`inputs/${id}`);
  }
  async saveInput(input: RawInput) {
    await guarded(() => this.db.doc(`inputs/${input.id}`).set(plain(input)));
  }
  listRequirements(projectId: number) {
    return this.list<Stored>(this.db.collection("requirements").where("project_id", "==", projectId));
  }
  getRequirement(id: number) {
    return this.read<Stored>(`requirements/${id}`);
  }
  async saveRequirements(requirements: Stored[]) {
    // 一次只写一个文档，逐个等待，符合存储“每个文档同一时间只有一次写入”的要求。
    for (const r of requirements) {
      await guarded(() => this.db.doc(`requirements/${r.id}`).set(plain(r)));
    }
  }
  reserveIds(count: number): Promise<number> {
    // 取号必须一个一个来：读计数器、加上去、写回，中间不能被另一次取号插进来，
    // 否则两次会拿到同一个编号，后写的会盖掉先写的。
    const run = this.idQueue.then(() => this.reserveIdsExclusive(count));
    this.idQueue = run.catch(() => undefined);
    return run;
  }

  private async reserveIdsExclusive(count: number): Promise<number> {
    const ref = this.db.doc("meta/counters");
    // 不同窗口之间靠存储提供的短时锁来互斥。锁会自动过期，拿不到就稍等再试。
    if (ref.acquire) {
      let acquired = false;
      for (let attempt = 0; attempt < 8 && !acquired; attempt += 1) {
        if (attempt > 0) await sleep(400);
        acquired = (await guarded(() => ref.acquire!({ holder: this.holder, ttlMs: 2000 }))).acquired;
      }
      if (!acquired) throw new Error("另一个窗口正在录入，请稍等几秒再试。");
    }
    const snapshot = await guarded(() => ref.get());
    const first = Number(snapshot.data()?.next ?? 1);
    await guarded(() => ref.set({ ...snapshot.data(), next: first + count }));
    return first;
  }
  async logCall(call: LlmCallRecord) {
    await guarded(() => this.db.collection("llm_calls").add(plain(call)));
  }
}
