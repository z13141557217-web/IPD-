import { describe, expect, it } from "vitest";

import { blankRequirement, DbPersistence, type DocStore } from "./persistence";

/** 模拟平台的文档存储：每次读写都有一点延迟，这样并发的问题才会暴露出来。 */
function fakeStore(options: { withLease?: boolean } = {}) {
  const docs = new Map<string, Record<string, unknown>>();
  const leases = new Map<string, { holder: string; until: number }>();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
  const snap = (path: string) => {
    const data = docs.get(path);
    return { id: path.split("/").pop()!, exists: data !== undefined, data: () => data };
  };
  const docRef = (path: string) => ({
    get: async () => (await wait(), snap(path)),
    set: async (data: Record<string, unknown>) => {
      await wait();
      docs.set(path, structuredClone(data));
    },
    delete: async () => {
      await wait();
      docs.delete(path);
    },
    ...(options.withLease
      ? {
          acquire: async ({ holder, ttlMs = 30000 }: { holder: string; ttlMs?: number }) => {
            await wait();
            const lease = leases.get(path);
            if (lease && lease.holder !== holder && lease.until > Date.now()) return { acquired: false };
            leases.set(path, { holder, until: Date.now() + ttlMs });
            return { acquired: true };
          },
        }
      : {}),
  });
  const query = (collection: string, filters: [string, unknown][] = [], max = Infinity) => ({
    where: (field: string, _op: string, value: unknown) => query(collection, [...filters, [field, value]], max),
    limit: (n: number) => query(collection, filters, n),
    get: async () => {
      await wait();
      const matched = [...docs.keys()]
        .filter((path) => path.startsWith(`${collection}/`))
        .filter((path) => filters.every(([f, v]) => docs.get(path)![f] === v))
        .slice(0, max)
        .map(snap);
      return { docs: matched };
    },
    doc: (docId?: string) => docRef(`${collection}/${docId ?? Math.random().toString(36).slice(2)}`),
    add: async (data: Record<string, unknown>) => {
      await docRef(`${collection}/${Math.random().toString(36).slice(2)}`).set(data);
    },
  });
  const store: DocStore = { doc: docRef, collection: (path) => query(path) };
  return { store, docs };
}

describe("DbPersistence 取号", () => {
  it("同一个窗口里同时取号，不会拿到相同的编号", async () => {
    const { store } = fakeStore();
    const db = new DbPersistence(store);
    const ids = await Promise.all([db.reserveIds(1), db.reserveIds(1), db.reserveIds(3), db.reserveIds(1)]);
    expect(ids).toEqual([1, 2, 3, 6]);
    expect(await db.reserveIds(1)).toBe(7);
  });

  it("两个窗口同时取号，靠存储的短时锁互斥", async () => {
    const { store } = fakeStore({ withLease: true });
    const [a, b] = [new DbPersistence(store), new DbPersistence(store)];
    const ids = await Promise.all([a.reserveIds(1), b.reserveIds(1), a.reserveIds(1), b.reserveIds(1)]);
    expect(new Set(ids).size).toBe(4);
    expect([...ids].sort()).toEqual([1, 2, 3, 4]);
  }, 20000);

  it("一次取号失败不会卡住后面的取号", async () => {
    const { store } = fakeStore();
    const db = new DbPersistence(store);
    const original = store.doc;
    let fail = true;
    store.doc = (path) => {
      const ref = original(path);
      return fail ? { ...ref, get: async () => Promise.reject({ code: "quota_exceeded" }) } : ref;
    };
    await expect(db.reserveIds(1)).rejects.toThrow("存储空间已满");
    fail = false;
    expect(await db.reserveIds(1)).toBe(1);
  });
});

describe("DbPersistence 删除项目", () => {
  it("连同材料、需求、调用记录一起删掉，不影响别的项目", async () => {
    const { store, docs } = fakeStore();
    const db = new DbPersistence(store);
    for (const pid of [1, 2]) {
      await db.saveProject({ id: pid, name: `p${pid}`, description: "", dismissed_probes: [] });
      await db.saveInput({
        id: pid * 10, project_id: pid, source_type: "", requester: "", content: "x",
        status: "processed", error: null, created_at: "",
      });
      await db.saveRequirements([
        { ...blankRequirement(), id: pid * 100, project_id: pid, title: "a" },
        { ...blankRequirement(), id: pid * 100 + 1, project_id: pid, title: "b" },
      ]);
      await db.logCall({
        project_id: pid, input_id: null, task: "t", prompt_version: "v", provider: "p", model: "m",
        request: { system: "", user: "" }, response: "r", error: null, latency_ms: 1, created_at: "",
      });
    }
    await db.deleteProject(1);
    const left = [...docs.keys()].map((path) => path.split("/")[0]).sort();
    expect(left).toEqual(["inputs", "llm_calls", "projects", "requirements", "requirements"]);
    expect((await db.listProjects()).map((p) => p.id)).toEqual([2]);
    expect((await db.listRequirements(2)).length).toBe(2);
    expect(await db.listRequirements(1)).toEqual([]);
  });
});
