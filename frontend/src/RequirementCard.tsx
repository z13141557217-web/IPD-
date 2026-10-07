import { useState } from "react";

import type { AppealsDimension, Priority, Requirement, RequirementPatch } from "./api";

const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const STATUS_LABEL = { draft: "待确认", confirmed: "已确认", rejected: "已否决" } as const;

interface Props {
  requirement: Requirement;
  dimensions: AppealsDimension[];
  onUpdate: (id: number, patch: RequirementPatch) => Promise<void>;
}

export default function RequirementCard({ requirement: r, dimensions, onUpdate }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [description, setDescription] = useState(r.description);
  const [saving, setSaving] = useState(false);

  async function update(patch: RequirementPatch) {
    setSaving(true);
    try {
      await onUpdate(r.id, patch);
    } finally {
      setSaving(false);
    }
  }

  async function saveText() {
    if (!title.trim()) return;
    await update({ title, description });
    setEditing(false);
  }

  function cancelEdit() {
    setTitle(r.title);
    setDescription(r.description);
    setEditing(false);
  }

  return (
    <article className={`req req-${r.status}`}>
      <header className="req-head">
        <span className="req-id">#{r.id}</span>
        {editing ? (
          <input
            className="req-title-input"
            value={title}
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="需求标题"
          />
        ) : (
          <h3 className="req-title">{r.title}</h3>
        )}
        <span className={`badge badge-${r.status}`}>{STATUS_LABEL[r.status]}</span>
      </header>

      {editing ? (
        <textarea
          className="req-desc-input"
          value={description}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="需求说明"
        />
      ) : (
        r.description && <p className="req-desc">{r.description}</p>
      )}

      {r.duplicate_of_id !== null && (
        <p className="req-note req-note-warn">可能与 #{r.duplicate_of_id} 重复，请核对后决定是否否决。</p>
      )}

      <blockquote className="req-quote">
        <span className="req-quote-label">依据原文</span>
        {r.source_quote ? `“${r.source_quote}”` : "模型没有给出原文依据。"}
        {r.source_quote && (
          <span className={r.quote_verified ? "verify verify-ok" : "verify verify-bad"}>
            {r.quote_verified ? "已在材料中找到" : "材料中找不到这句话，可能是模型改写或编造"}
          </span>
        )}
      </blockquote>

      <div className="req-fields">
        <label>
          $APPEALS 维度
          <select
            value={r.appeals ?? ""}
            disabled={saving}
            onChange={(e) => update({ appeals: e.target.value || null })}
          >
            <option value="">未归类</option>
            {dimensions.map((d) => (
              <option key={d.key} value={d.key} title={d.description}>
                {d.code} {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          优先级
          <select
            value={r.priority}
            disabled={saving}
            onChange={(e) => update({ priority: e.target.value as Priority })}
          >
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        {r.priority_reason && <p className="req-reason">建议理由：{r.priority_reason}</p>}
      </div>

      <footer className="req-actions">
        {editing ? (
          <>
            <button className="btn btn-primary" disabled={saving || !title.trim()} onClick={saveText}>
              保存
            </button>
            <button className="btn" disabled={saving} onClick={cancelEdit}>
              取消
            </button>
          </>
        ) : (
          <>
            {r.status !== "confirmed" && (
              <button
                className="btn btn-primary"
                disabled={saving}
                onClick={() => update({ status: "confirmed" })}
              >
                确认
              </button>
            )}
            {r.status !== "rejected" && (
              <button className="btn" disabled={saving} onClick={() => update({ status: "rejected" })}>
                否决
              </button>
            )}
            {r.status !== "draft" && (
              <button className="btn" disabled={saving} onClick={() => update({ status: "draft" })}>
                退回待确认
              </button>
            )}
            <button className="btn" disabled={saving} onClick={() => setEditing(true)}>
              编辑文字
            </button>
          </>
        )}
      </footer>
    </article>
  );
}
