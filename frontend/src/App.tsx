import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  IS_DEMO,
  IS_HOSTED,
  type AppealsDimension,
  type ClassificationRules,
  type Health,
  type Project,
  type RawInput,
  type Requirement,
  type RequirementPatch,
  type RequirementStatus,
} from "./api";
import DispositionView from "./DispositionView";
import QuestionList, { type Probe } from "./QuestionList";
import RequirementRow from "./RequirementRow";
import SettingsPage from "./SettingsPage";

const SOURCE_TYPES = ["客户", "销售或市场", "内部部门", "行业标准或法规", "其他"];
const STATUS_TABS: { key: RequirementStatus | "all"; label: string }[] = [
  { key: "draft", label: "待确认" },
  { key: "confirmed", label: "已确认" },
  { key: "rejected", label: "已否决" },
  { key: "merged", label: "已合并" },
  { key: "all", label: "全部" },
];
type Scope = "all" | "stated" | "latent" | "strategic" | "project";
const SCOPES: { key: Scope; label: string }[] = [
  { key: "all", label: "所有需求" },
  { key: "stated", label: "客户提出的" },
  { key: "latent", label: "潜在需求假设" },
  { key: "strategic", label: "长期需求" },
  { key: "project", label: "单次项目需求" },
];
type View = "list" | "questions" | "dispositions";
// 盲区提示至少要有这么多条需求才出现，太少时说“没有”没有意义。
const MIN_FOR_BLIND_SPOTS = 3;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "发生未知错误";
}

function inScope(r: Requirement, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === "stated" || scope === "latent") return r.kind === scope;
  return r.demand_type === scope;
}

/** 类别筛选的 key：功能、设计约束、未定各一个，质量属性按具体方面分。 */
function categoryKeyOf(r: Requirement): string {
  return r.category === "quality" ? `quality:${r.subcategory ?? ""}` : r.category;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dimensions, setDimensions] = useState<AppealsDimension[]>([]);
  const [rules, setRules] = useState<ClassificationRules | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [failedInputs, setFailedInputs] = useState<RawInput[]>([]);
  // 刚分析出来的需求默认展开，其余默认折叠。
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());

  const [newProjectName, setNewProjectName] = useState("");
  const [content, setContent] = useState("");
  const [sourceType, setSourceType] = useState(SOURCE_TYPES[0]);
  const [requester, setRequester] = useState("");
  const [busy, setBusy] = useState<null | "extract" | "latent">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState<"work" | "settings">("work");
  const [view, setView] = useState<View>("list");
  const [statusFilter, setStatusFilter] = useState<RequirementStatus | "all">("draft");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("all");

  const [editingBackground, setEditingBackground] = useState(false);
  const [backgroundDraft, setBackgroundDraft] = useState("");

  const project = projects.find((p) => p.id === projectId) ?? null;
  // 当前选中的项目。请求返回时用它判断结果是否还属于正在看的项目，
  // 避免切换项目后，上一个项目迟到的数据盖住当前项目。
  const activeProjectRef = useRef<number | null>(null);
  activeProjectRef.current = projectId;

  useEffect(() => {
    Promise.all([api.health(), api.appeals(), api.classification(), api.listProjects()])
      .then(([h, appeals, classification, ps]) => {
        setHealth(h);
        setDimensions(appeals.dimensions);
        setRules(classification);
        setProjects(ps);
        if (ps.length > 0) setProjectId(ps[0].id);
      })
      .catch((err) => setError(messageOf(err)));
  }, []);

  const loadProjectData = useCallback(async (id: number) => {
    const [reqs, inputs] = await Promise.all([api.listRequirements(id), api.listInputs(id)]);
    if (activeProjectRef.current !== id) return;
    setRequirements(reqs);
    setFailedInputs(inputs.filter((i) => i.status !== "processed"));
  }, []);

  useEffect(() => {
    setRequirements([]);
    setFailedInputs([]);
    setFreshIds(new Set());
    setNotice(null);
    setEditingBackground(false);
    setView("list");
    setStatusFilter("draft");
    setCategoryFilter(null);
    setScope("all");
    if (projectId === null) return;
    const id = projectId;
    loadProjectData(id).catch(
      (err) => activeProjectRef.current === id && setError(messageOf(err)),
    );
  }, [projectId, loadProjectData]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    setError(null);
    try {
      const created = await api.createProject(name);
      setProjects((ps) => [created, ...ps]);
      setProjectId(created.id);
      setNewProjectName("");
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function patchProject(patch: Parameters<typeof api.updateProject>[1]) {
    if (!project) return false;
    setError(null);
    try {
      const updated = await api.updateProject(project.id, patch);
      setProjects((ps) => ps.map((p) => (p.id === updated.id ? updated : p)));
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    }
  }

  async function saveBackground() {
    if (await patchProject({ description: backgroundDraft })) setEditingBackground(false);
  }

  function showResults(ids: number[]) {
    setFreshIds(new Set(ids));
    setView("list");
    setStatusFilter("draft");
    setCategoryFilter(null);
  }

  async function runExtraction(run: () => ReturnType<typeof api.submitInput>, onSuccess?: () => void) {
    if (projectId === null) return;
    setBusy("extract");
    setError(null);
    setNotice(null);
    try {
      const result = await run();
      if (activeProjectRef.current !== projectId) return;
      if (result.input.status === "failed") {
        const reason = (result.input.error ?? "原因未知").replace(/[。.]+$/, "");
        setError(`材料已保存，但分析失败：${reason}。可以在下方重试。`);
      } else {
        const n = result.requirements.length;
        setNotice(n > 0 ? `分析出 ${n} 条需求，已展开在下方，请逐条核对。` : "这份材料里没有识别出需求。");
        if (n > 0) {
          setScope("all");
          showResults(result.requirements.map((r) => r.id));
        }
        onSuccess?.();
      }
      await loadProjectData(projectId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  function submitInput(e?: React.FormEvent) {
    e?.preventDefault();
    if (projectId === null || !content.trim() || busy) return;
    void runExtraction(
      () => api.submitInput(projectId, content, sourceType, requester),
      () => {
        setContent("");
        // 提出者不沿用到下一份材料，免得张冠李戴。
        setRequester("");
      },
    );
  }

  async function discoverLatentNeeds() {
    if (projectId === null) return;
    setBusy("latent");
    setError(null);
    setNotice(null);
    try {
      const result = await api.discoverLatentNeeds(projectId);
      if (activeProjectRef.current !== projectId) return;
      const n = result.requirements.length;
      const dropped = result.dropped_without_basis;
      const droppedNote = dropped > 0 ? `另有 ${dropped} 条给不出依据，已丢弃。` : "";
      if (n > 0) {
        setNotice(`提出 ${n} 条潜在需求假设，向客户验证成立后才能确认。${droppedNote}`);
        setScope("latent");
        showResults(result.requirements.map((r) => r.id));
      } else if (health?.demo_mode) {
        setNotice("演示模式无法分析潜在需求，这一步需要接入大模型。");
      } else {
        setNotice(`现有需求不足以支撑新的假设。${droppedNote}`);
      }
      await loadProjectData(projectId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function updateRequirement(id: number, patch: RequirementPatch) {
    setError(null);
    try {
      const updated = await api.updateRequirement(id, patch);
      // 取消合并会改变目标需求的“几处提到”，这种情况整体重新加载。
      if ("status" in patch && projectId !== null) await loadProjectData(projectId);
      else setRequirements((rs) => rs.map((r) => (r.id === id ? updated : r)));
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function mergeRequirement(id: number, targetId: number) {
    setError(null);
    try {
      const { merged, target } = await api.mergeRequirement(id, targetId);
      setRequirements((rs) =>
        rs.map((r) => (r.id === merged.id ? merged : r.id === target.id ? target : r)),
      );
      setNotice(`已并入 #${target.id}，现在共 ${target.mention_count} 处提到这件事。`);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  // 仍然有效的需求：没有被否决，也没有并入别的需求。
  const active = useMemo(
    () => requirements.filter((r) => r.status !== "rejected" && r.status !== "merged"),
    [requirements],
  );

  // 类别覆盖：功能、每个质量属性、设计约束各有多少条。
  const coverage = useMemo(() => {
    if (!rules) return [];
    const count = (key: string) => active.filter((r) => categoryKeyOf(r) === key).length;
    const chips = [
      { key: "functional", name: "功能", count: count("functional"), quality: false },
      ...rules.quality_attributes.map((q) => ({
        key: `quality:${q.key}`,
        name: q.name,
        count: count(`quality:${q.key}`),
        quality: true,
      })),
      { key: "constraint", name: "设计约束", count: count("constraint"), quality: false },
    ];
    const unknown = active.filter((r) => r.category === "unknown" || categoryKeyOf(r) === "quality:").length;
    return unknown > 0 ? [...chips, { key: "unknown", name: "类别未定", count: unknown, quality: false }] : chips;
  }, [rules, active]);

  // 还没问到的方面：一条需求都没有、用户也没说过“客户不在意”的质量属性和约束。
  const probes = useMemo<Probe[]>(() => {
    if (!rules || !project || active.length < MIN_FOR_BLIND_SPOTS) return [];
    const dismissed = new Set(project.dismissed_probes);
    const has = (key: string) => active.some((r) => categoryKeyOf(r) === key);
    const list: Probe[] = rules.quality_attributes
      .filter((q) => !has(`quality:${q.key}`) && !dismissed.has(q.key))
      .map((q) => ({ key: q.key, name: q.name, question: q.probe }));
    if (!has("constraint") && !dismissed.has("constraint")) {
      list.push({ key: "constraint", name: "设计约束", question: rules.constraint_probe });
    }
    return list;
  }, [rules, project, active]);

  // 下一步该做什么：数字都来自现有数据，点一下直接跳到对应的内容。
  const todo = useMemo(
    () => ({
      confirm: requirements.filter(
        (r) => r.status === "draft" && !(r.kind === "latent" && r.validation_status !== "validated"),
      ).length,
      ask: active.reduce((sum, r) => sum + r.open_questions.length, 0) + probes.length,
      validate: requirements.filter(
        (r) => r.kind === "latent" && r.status === "draft" && r.validation_status === "unverified",
      ).length,
    }),
    [requirements, active, probes],
  );
  const confirmedCount = requirements.filter((r) => r.status === "confirmed").length;

  const scoped = requirements.filter(
    (r) =>
      inScope(r, scope) &&
      (categoryFilter === null ||
        (categoryFilter === "unknown"
          ? r.category === "unknown" || categoryKeyOf(r) === "quality:"
          : categoryKeyOf(r) === categoryFilter)),
  );
  const visible = scoped.filter((r) =>
    statusFilter === "all" ? r.status !== "merged" : r.status === statusFilter,
  );
  const countByStatus = (key: RequirementStatus | "all") =>
    key === "all"
      ? scoped.filter((r) => r.status !== "merged").length
      : scoped.filter((r) => r.status === key).length;

  function jump(next: { status: RequirementStatus | "all"; scope: Scope }) {
    setView("list");
    setStatusFilter(next.status);
    setScope(next.scope);
    setCategoryFilter(null);
  }

  const blindNames = probes.filter((p) => p.key !== "constraint").map((p) => p.name);

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1 className="brand">IPD 需求助手</h1>
        <h2 className="side-title">项目</h2>
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={p.id === projectId && page === "work" ? "project active" : "project"}
                aria-current={p.id === projectId && page === "work"}
                onClick={() => {
                  setProjectId(p.id);
                  setPage("work");
                }}
              >
                {p.name}
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="muted">还没有项目，在下面新建一个。</li>}
        </ul>
        <form className="new-project" onSubmit={createProject}>
          <input
            value={newProjectName}
            maxLength={200}
            placeholder="新项目名称"
            aria-label="新项目名称"
            onChange={(e) => setNewProjectName(e.target.value)}
          />
          <button className="btn" disabled={!newProjectName.trim()}>
            新建
          </button>
        </form>
        <div className="side-foot">
          <button
            className={page === "settings" ? "project active" : "project"}
            aria-current={page === "settings"}
            onClick={() => setPage(page === "settings" ? "work" : "settings")}
          >
            设置
          </button>
          {health && (
            <p className="model-info">
              模型：{health.demo_mode ? "未接入（演示模式）" : health.llm_model || health.llm_provider}
              <br />
              版本 {health.version}
            </p>
          )}
        </div>
      </aside>

      <main className="main">
        {IS_DEMO && (
          <div className="banner banner-warn" role="status">
            这是界面预览版：数据是示例，保存在这个页面里，刷新后恢复原样；其中的分析内容是手写的示例，不是模型的输出。
          </div>
        )}
        {health?.warning && (
          <div className="banner banner-error" role="alert">
            {health.warning}
          </div>
        )}
        {health?.demo_mode && !IS_DEMO && page === "work" && (
          <div className="banner banner-warn" role="status">
            演示模式：没有接入大模型，只按标点拆句、按关键词归类，不做任何分析。接入模型后结果才有参考价值。
          </div>
        )}
        {error && page === "work" && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}

        {page === "settings" ? (
          <SettingsPage onSaved={() => void api.health().then(setHealth).catch(() => undefined)} />
        ) : project === null ? (
          <p className="empty">在左侧新建或选择一个项目。</p>
        ) : (
          <>
            <header className="project-head">
              <h2>{project.name}</h2>
              {editingBackground ? (
                <div className="background-edit">
                  <textarea
                    autoFocus
                    rows={4}
                    maxLength={5000}
                    value={backgroundDraft}
                    aria-label="客户背景"
                    placeholder="客户是谁、什么行业、用产品做什么事、现在是怎么凑合的。写得越具体，推断越贴近实际。"
                    onChange={(e) => setBackgroundDraft(e.target.value)}
                  />
                  <div className="actions">
                    <button className="btn btn-primary" onClick={() => void saveBackground()}>
                      保存背景
                    </button>
                    <button className="btn" onClick={() => setEditingBackground(false)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <p className={project.description ? "background" : "background background-missing"}>
                  {project.description
                    ? `客户背景：${project.description}`
                    : "还没有填写客户背景。没有背景时，模型只能凭材料里的只言片语猜测场景。"}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setBackgroundDraft(project.description);
                      setEditingBackground(true);
                    }}
                  >
                    {project.description ? "修改" : "填写背景"}
                  </button>
                </p>
              )}
            </header>

            {requirements.length > 0 && (
              <nav className="todo" aria-label="下一步">
                {todo.confirm + todo.ask + todo.validate === 0 ? (
                  <p className="todo-clear">没有待办。有新的客户材料时录入即可。</p>
                ) : (
                  <>
                    {todo.confirm > 0 && (
                      <button onClick={() => jump({ status: "draft", scope: "all" })}>
                        <strong>{todo.confirm}</strong> 条需求等你确认
                      </button>
                    )}
                    {todo.ask > 0 && (
                      <button onClick={() => setView("questions")}>
                        <strong>{todo.ask}</strong> 个问题要去问客户
                      </button>
                    )}
                    {todo.validate > 0 && (
                      <button onClick={() => jump({ status: "draft", scope: "latent" })}>
                        <strong>{todo.validate}</strong> 条假设等待验证
                      </button>
                    )}
                  </>
                )}
              </nav>
            )}

            <section className="panel">
              <form onSubmit={submitInput}>
                <textarea
                  value={content}
                  rows={5}
                  maxLength={50000}
                  placeholder="把客户反馈、访谈记录、会议纪要或内部提的需求粘贴到这里。"
                  aria-label="原始材料"
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitInput();
                  }}
                />
                <div className="form-foot">
                  <label className="inline">
                    来自
                    <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                      {SOURCE_TYPES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <input
                    className="requester"
                    value={requester}
                    maxLength={100}
                    placeholder="客户名称或提出人，可不填"
                    aria-label="提出者"
                    onChange={(e) => setRequester(e.target.value)}
                  />
                  <span className="muted hint">Ctrl 或 ⌘ + Enter 提交</span>
                  <button className="btn btn-primary" disabled={busy !== null || !content.trim()}>
                    {busy === "extract" ? "正在分析…" : "分析需求"}
                  </button>
                </div>
              </form>

              {busy !== null && IS_HOSTED && (
                <p className="muted" role="status">
                  模型正在分析，通常需要十几秒到一分钟，材料长时会更久。第一次使用时请留意是否弹出了授权提示。
                </p>
              )}

              {failedInputs.length > 0 && (
                <div className="failed">
                  <h3>没有分析成功的材料</h3>
                  <ul>
                    {failedInputs.map((i) => (
                      <li key={i.id}>
                        <span>
                          {i.content.slice(0, 60)}
                          {i.content.length > 60 ? "…" : ""}
                        </span>
                        <button
                          className="btn"
                          disabled={busy !== null}
                          onClick={() => void runExtraction(() => api.retryExtraction(i.id))}
                        >
                          重试
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {notice && (
              <div className="banner banner-ok" role="status">
                {notice}
              </div>
            )}

            {requirements.length === 0 ? (
              <p className="empty">
                这个项目还没有需求。先填写客户背景，再把一份客户材料粘贴到上面的框里。
              </p>
            ) : (
              <section className="panel">
                <div className="view-head">
                  <div className="views" role="tablist" aria-label="视图">
                    <button
                      role="tab"
                      aria-selected={view === "list"}
                      className={view === "list" ? "view active" : "view"}
                      onClick={() => setView("list")}
                    >
                      需求
                    </button>
                    <button
                      role="tab"
                      aria-selected={view === "questions"}
                      className={view === "questions" ? "view active" : "view"}
                      onClick={() => setView("questions")}
                    >
                      追问清单{todo.ask > 0 ? ` ${todo.ask}` : ""}
                    </button>
                    <button
                      role="tab"
                      aria-selected={view === "dispositions"}
                      className={view === "dispositions" ? "view active" : "view"}
                      onClick={() => setView("dispositions")}
                    >
                      去向{confirmedCount > 0 ? ` ${confirmedCount}` : ""}
                    </button>
                  </div>
                  <button
                    className="btn"
                    disabled={busy !== null}
                    title="从已有需求的共性中，找出客户没有明说的潜在需求"
                    onClick={() => void discoverLatentNeeds()}
                  >
                    {busy === "latent" ? "分析中…" : "发现潜在需求"}
                  </button>
                </div>

                {view === "questions" && (
                  <QuestionList
                    projectName={project.name}
                    requirements={requirements}
                    probes={probes}
                    onUpdate={updateRequirement}
                    onDismissProbe={(key) =>
                      void patchProject({ dismissed_probes: [...project.dismissed_probes, key] })
                    }
                  />
                )}
                {view === "dispositions" && (
                  <DispositionView projectName={project.name} requirements={requirements} rules={rules} />
                )}
                {view === "list" && (
                  <>
                    <div className="coverage">
                      <div className="chips" role="group" aria-label="按需求类别筛选">
                        {coverage.map((c) => (
                          <button
                            key={c.key}
                            aria-pressed={categoryFilter === c.key}
                            className={`chip${c.count === 0 && c.quality ? " chip-empty" : ""}${categoryFilter === c.key ? " chip-on" : ""}`}
                            onClick={() => setCategoryFilter(categoryFilter === c.key ? null : c.key)}
                          >
                            {c.name} {c.count}
                          </button>
                        ))}
                      </div>
                      {blindNames.length > 0 && (
                        <p className="blind">
                          {blindNames.join("、")}方面还没有任何需求。
                          <button type="button" className="link" onClick={() => setView("questions")}>
                            追问清单里备好了对应的问题
                          </button>
                        </p>
                      )}
                    </div>

                    <div className="list-controls">
                      <div className="tabs" role="tablist" aria-label="按状态筛选">
                        {STATUS_TABS.filter((t) => t.key !== "merged" || countByStatus("merged") > 0).map(
                          (t) => (
                            <button
                              key={t.key}
                              role="tab"
                              aria-selected={statusFilter === t.key}
                              className={statusFilter === t.key ? "tab active" : "tab"}
                              onClick={() => setStatusFilter(t.key)}
                            >
                              {t.label} {countByStatus(t.key)}
                            </button>
                          ),
                        )}
                      </div>
                      <select
                        value={scope}
                        aria-label="按类型筛选"
                        onChange={(e) => setScope(e.target.value as Scope)}
                      >
                        {SCOPES.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {visible.length === 0 ? (
                      <p className="empty">这个筛选条件下没有需求。</p>
                    ) : (
                      <div className="rows">
                        {visible.map((r) => (
                          <RequirementRow
                            key={r.id}
                            requirement={r}
                            dimensions={dimensions}
                            rules={rules}
                            defaultOpen={freshIds.has(r.id)}
                            onUpdate={updateRequirement}
                            onMerge={mergeRequirement}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
