import { useCallback, useEffect, useMemo, useState } from "react";

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
import RequirementCard from "./RequirementCard";

const SOURCE_TYPES = ["客户反馈", "访谈记录", "会议纪要", "销售反馈", "其他"];
const STATUS_TABS: { key: RequirementStatus | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "draft", label: "待确认" },
  { key: "confirmed", label: "已确认" },
  { key: "rejected", label: "已否决" },
];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "发生未知错误";
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dimensions, setDimensions] = useState<AppealsDimension[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [failedInputs, setFailedInputs] = useState<RawInput[]>([]);

  const [newProjectName, setNewProjectName] = useState("");
  const [content, setContent] = useState("");
  const [sourceType, setSourceType] = useState(SOURCE_TYPES[0]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<RequirementStatus | "all">("all");
  const [appealsFilter, setAppealsFilter] = useState("all");

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
    setRequirements(reqs);
    setFailedInputs(inputs.filter((i) => i.status !== "processed"));
  }, []);

  useEffect(() => {
    setRequirements([]);
    setFailedInputs([]);
    setNotice(null);
    if (projectId === null) return;
    let cancelled = false;
    Promise.all([api.listRequirements(projectId), api.listInputs(projectId)])
      .then(([reqs, inputs]) => {
        if (cancelled) return;
        setRequirements(reqs);
        setFailedInputs(inputs.filter((i) => i.status !== "processed"));
      })
      .catch((err) => !cancelled && setError(messageOf(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    setError(null);
    try {
      const project = await api.createProject(name);
      setProjects((ps) => [project, ...ps]);
      setProjectId(project.id);
      setNewProjectName("");
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function runExtraction(run: () => ReturnType<typeof api.submitInput>, onSuccess?: () => void) {
    if (projectId === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await run();
      if (result.input.status === "failed") {
        setError(`材料已保存，但提取失败：${result.input.error ?? "原因未知"}。可在下方重试。`);
      } else {
        const n = result.requirements.length;
        setNotice(n > 0 ? `提取出 ${n} 条需求，请逐条核对后确认。` : "这份材料里没有识别出需求。");
        onSuccess?.();
      }
      await loadProjectData(projectId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function submitInput(e: React.FormEvent) {
    e.preventDefault();
    if (projectId === null || !content.trim()) return;
    void runExtraction(
      () => api.submitInput(projectId, content, sourceType),
      () => setContent(""),
    );
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

  const visible = useMemo(
    () =>
      requirements.filter(
        (r) =>
          (statusFilter === "all" || r.status === statusFilter) &&
          (appealsFilter === "all" ||
            (appealsFilter === "none" ? r.appeals === null : r.appeals === appealsFilter)),
      ),
    [requirements, statusFilter, appealsFilter],
  );

  const countByStatus = (key: RequirementStatus | "all") =>
    key === "all" ? requirements.length : requirements.filter((r) => r.status === key).length;

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
                onClick={() => setProjectId(p.id)}
              >
                {p.name}
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="muted">还没有项目，先在下面新建一个。</li>}
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
            当前是演示模式：没有接入大模型，只是按标点拆句、按关键词归类，优先级一律为中。
            结果仅用于跑通流程，接入模型后才有参考价值。
          </div>
        )}
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="banner banner-ok" role="status">
            {notice}
          </div>
        )}

        {projectId === null ? (
          <p className="empty">在左侧新建或选择一个项目后开始。</p>
        ) : (
          <>
            <section className="card">
              <h2>录入原始材料</h2>
              <form onSubmit={submitInput}>
                <label className="field">
                  材料来源
                  <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                    {SOURCE_TYPES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <textarea
                  value={content}
                  rows={8}
                  maxLength={50000}
                  placeholder="把客户反馈、访谈记录或会议纪要粘贴到这里。"
                  aria-label="原始材料"
                  onChange={(e) => setContent(e.target.value)}
                />
                <div className="form-foot">
                  <span className="muted">{content.length} / 50000 字</span>
                  <button className="btn btn-primary" disabled={busy || !content.trim()}>
                    {busy ? "正在提取…" : "提取需求"}
                  </button>
                </div>
              </form>

              {failedInputs.length > 0 && (
                <div className="failed">
                  <h3>未完成提取的材料</h3>
                  <ul>
                    {failedInputs.map((i) => (
                      <li key={i.id}>
                        <span className="failed-text">
                          {i.content.slice(0, 60)}
                          {i.content.length > 60 ? "…" : ""}
                        </span>
                        <button
                          className="btn"
                          disabled={busy}
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

            <section className="card">
              <div className="list-head">
                <h2>需求列表</h2>
                <label className="field field-inline">
                  维度
                  <select value={appealsFilter} onChange={(e) => setAppealsFilter(e.target.value)}>
                    <option value="all">全部维度</option>
                    {dimensions.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.code} {d.name}
                      </option>
                    ))}
                    <option value="none">未归类</option>
                  </select>
                </label>
              </div>
              <div className="tabs" role="tablist">
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
              {visible.length === 0 ? (
                <p className="empty">
                  {requirements.length === 0 ? "还没有需求，先录入一份材料。" : "没有符合筛选条件的需求。"}
                </p>
              ) : (
                <div className="req-list">
                  {visible.map((r) => (
                    <RequirementCard
                      key={r.id}
                      requirement={r}
                      dimensions={dimensions}
                      onUpdate={updateRequirement}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
