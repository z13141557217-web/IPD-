import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type AppealsDimension,
  type Health,
  type Project,
  type RawInput,
  type Requirement,
  type RequirementPatch,
  type RequirementStatus,
} from "./api";
import QuestionList from "./QuestionList";
import RequirementRow from "./RequirementRow";

const SOURCE_TYPES = ["客户反馈", "访谈记录", "会议纪要", "销售反馈", "其他"];
const STATUS_TABS: { key: RequirementStatus | "all"; label: string }[] = [
  { key: "draft", label: "待确认" },
  { key: "confirmed", label: "已确认" },
  { key: "rejected", label: "已否决" },
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
type View = "list" | "questions";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "发生未知错误";
}

function inScope(r: Requirement, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === "stated" || scope === "latent") return r.kind === scope;
  return r.demand_type === scope;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dimensions, setDimensions] = useState<AppealsDimension[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [failedInputs, setFailedInputs] = useState<RawInput[]>([]);
  // 刚分析出来的需求默认展开，其余默认折叠。
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());

  const [newProjectName, setNewProjectName] = useState("");
  const [content, setContent] = useState("");
  const [sourceType, setSourceType] = useState(SOURCE_TYPES[0]);
  const [busy, setBusy] = useState<null | "extract" | "latent">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>("list");
  const [statusFilter, setStatusFilter] = useState<RequirementStatus | "all">("draft");
  const [appealsFilter, setAppealsFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("all");

  const [editingBackground, setEditingBackground] = useState(false);
  const [backgroundDraft, setBackgroundDraft] = useState("");

  const project = projects.find((p) => p.id === projectId) ?? null;
  // 当前选中的项目。请求返回时用它判断结果是否还属于正在看的项目，
  // 避免切换项目后，上一个项目迟到的数据盖住当前项目。
  const activeProjectRef = useRef<number | null>(null);
  activeProjectRef.current = projectId;

  useEffect(() => {
    Promise.all([api.health(), api.appeals(), api.listProjects()])
      .then(([h, rules, ps]) => {
        setHealth(h);
        setDimensions(rules.dimensions);
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
    setAppealsFilter(null);
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

  async function saveBackground() {
    if (!project) return;
    setError(null);
    try {
      const updated = await api.updateProject(project.id, { description: backgroundDraft });
      setProjects((ps) => ps.map((p) => (p.id === updated.id ? updated : p)));
      setEditingBackground(false);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  function showResults(ids: number[]) {
    setFreshIds(new Set(ids));
    setView("list");
    setStatusFilter("draft");
    setAppealsFilter(null);
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
        setError(`材料已保存，但分析失败：${result.input.error ?? "原因未知"}。可以在下方重试。`);
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
      () => api.submitInput(projectId, content, sourceType),
      () => setContent(""),
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
      setRequirements((rs) => rs.map((r) => (r.id === id ? updated : r)));
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const active = useMemo(() => requirements.filter((r) => r.status !== "rejected"), [requirements]);

  // 下一步该做什么：三个数字都来自现有数据，点一下直接跳到对应的内容。
  const todo = useMemo(
    () => ({
      confirm: requirements.filter(
        (r) => r.status === "draft" && !(r.kind === "latent" && r.validation_status !== "validated"),
      ).length,
      ask: active.reduce((sum, r) => sum + r.open_questions.length, 0),
      validate: requirements.filter(
        (r) => r.kind === "latent" && r.status === "draft" && r.validation_status === "unverified",
      ).length,
    }),
    [requirements, active],
  );

  // 每个维度上有多少条未否决的需求；一条都没有的维度可能是盲区。
  const coverage = useMemo(
    () => dimensions.map((d) => ({ ...d, count: active.filter((r) => r.appeals === d.key).length })),
    [dimensions, active],
  );
  const blindSpots = coverage.filter((d) => d.count === 0);

  const scoped = requirements.filter(
    (r) => inScope(r, scope) && (appealsFilter === null || r.appeals === appealsFilter),
  );
  const visible = scoped.filter((r) => statusFilter === "all" || r.status === statusFilter);
  const countByStatus = (key: RequirementStatus | "all") =>
    key === "all" ? scoped.length : scoped.filter((r) => r.status === key).length;

  function jump(next: { status: RequirementStatus | "all"; scope: Scope }) {
    setView("list");
    setStatusFilter(next.status);
    setScope(next.scope);
    setAppealsFilter(null);
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1 className="brand">IPD 需求助手</h1>
        <h2 className="side-title">项目</h2>
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={p.id === projectId ? "project active" : "project"}
                aria-current={p.id === projectId}
                onClick={() => setProjectId(p.id)}
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
        {health && (
          <p className="model-info">
            模型：{health.demo_mode ? "未接入（演示模式）" : health.llm_model || health.llm_provider}
          </p>
        )}
      </aside>

      <main className="main">
        {health?.demo_mode && (
          <div className="banner banner-warn" role="status">
            演示模式：没有接入大模型，只按标点拆句、按关键词归类，不做任何分析。接入模型后结果才有参考价值。
          </div>
        )}
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}

        {project === null ? (
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
                  placeholder="把客户反馈、访谈记录或会议纪要粘贴到这里。"
                  aria-label="原始材料"
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitInput();
                  }}
                />
                <div className="form-foot">
                  <label className="inline">
                    来源
                    <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                      {SOURCE_TYPES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <span className="muted hint">Ctrl 或 ⌘ + Enter 提交</span>
                  <button className="btn btn-primary" disabled={busy !== null || !content.trim()}>
                    {busy === "extract" ? "正在分析…" : "分析需求"}
                  </button>
                </div>
              </form>

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

                {view === "questions" ? (
                  <QuestionList
                    projectName={project.name}
                    requirements={requirements}
                    onUpdate={updateRequirement}
                  />
                ) : (
                  <>
                    <div className="coverage">
                      <div className="chips" role="group" aria-label="按维度筛选">
                        {coverage.map((d) => (
                          <button
                            key={d.key}
                            title={d.description}
                            aria-pressed={appealsFilter === d.key}
                            className={`chip${d.count === 0 ? " chip-empty" : ""}${appealsFilter === d.key ? " chip-on" : ""}`}
                            onClick={() => setAppealsFilter(appealsFilter === d.key ? null : d.key)}
                          >
                            {d.name} {d.count}
                          </button>
                        ))}
                      </div>
                      {blindSpots.length > 0 && active.length >= 3 && (
                        <p className="blind">
                          {blindSpots.map((d) => d.name).join("、")}
                          方面还没有任何需求。是客户不在意，还是没有问到？
                        </p>
                      )}
                    </div>

                    <div className="list-controls">
                      <div className="tabs" role="tablist" aria-label="按状态筛选">
                        {STATUS_TABS.map((t) => (
                          <button
                            key={t.key}
                            role="tab"
                            aria-selected={statusFilter === t.key}
                            className={statusFilter === t.key ? "tab active" : "tab"}
                            onClick={() => setStatusFilter(t.key)}
                          >
                            {t.label} {countByStatus(t.key)}
                          </button>
                        ))}
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
                            defaultOpen={freshIds.has(r.id)}
                            onUpdate={updateRequirement}
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
