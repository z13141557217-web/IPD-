import { useState } from "react";

import type {
  AppealsDimension,
  Confidence,
  Priority,
  Requirement,
  RequirementPatch,
  ValidationStatus,
} from "./api";

const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const STATUS_LABEL = { draft: "待确认", confirmed: "已确认", rejected: "已否决" } as const;
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "把握高：材料直接说明了原因",
  medium: "把握中：有线索，含推断",
  low: "把握低：材料信息不足，主要是推测",
};
const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  unverified: "未验证",
  validated: "已验证成立",
  invalidated: "验证不成立",
};

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

  const isLatent = r.kind === "latent";
  const needsValidation = isLatent && r.validation_status !== "validated";

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
    <article className={`req req-${r.status} ${isLatent ? "req-latent" : ""}`}>
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
        {isLatent && <span className="badge badge-latent">潜在需求假设</span>}
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

      {isLatent ? (
        <dl className="analysis">
          <div>
            <dt>依据的需求</dt>
            <dd>{r.based_on.map((id) => `#${id}`).join("、")}</dd>
          </div>
          {r.reasoning && (
            <div>
              <dt>推理过程</dt>
              <dd>{r.reasoning}</dd>
            </div>
          )}
          {r.validation_plan && (
            <div>
              <dt>建议的验证方式</dt>
              <dd>{r.validation_plan}</dd>
            </div>
          )}
          <div>
            <dt>验证状态</dt>
            <dd className={`validation validation-${r.validation_status}`}>
              {VALIDATION_LABEL[r.validation_status]}
              {r.validation_status === "unverified" &&
                "。这是从已有需求推断出来的，客户并没有提过，验证成立后才能确认。"}
            </dd>
          </div>
        </dl>
      ) : (
        <>
          <dl className="analysis">
            {r.stated_request && (
              <div>
                <dt>客户的表面诉求</dt>
                <dd>{r.stated_request}</dd>
              </div>
            )}
            {r.underlying_problem && (
              <div>
                <dt>背后要解决的问题</dt>
                <dd>{r.underlying_problem}</dd>
              </div>
            )}
            {r.reasoning && (
              <div>
                <dt>推理过程</dt>
                <dd>
                  {r.reasoning}
                  <span className={`confidence confidence-${r.confidence}`}>
                    {CONFIDENCE_LABEL[r.confidence]}
                  </span>
                </dd>
              </div>
            )}
          </dl>
          <blockquote className="req-quote">
            <span className="req-quote-label">依据原文</span>
            {r.source_quote ? `“${r.source_quote}”` : "模型没有给出原文依据。"}
            {r.source_quote && (
              <span className={r.quote_verified ? "verify verify-ok" : "verify verify-bad"}>
                {r.quote_verified ? "已在材料中找到" : "材料中找不到这句话，可能是模型改写或编造"}
              </span>
            )}
          </blockquote>
        </>
      )}

      {r.open_questions.length > 0 && (
        <div className="questions">
          <span className="questions-label">待向客户追问</span>
          <ul>
            {r.open_questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}

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
            {isLatent && r.validation_status === "unverified" && r.status === "draft" && (
              <>
                <button
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => update({ validation_status: "validated" })}
                >
                  已向客户验证，成立
                </button>
                <button
                  className="btn"
                  disabled={saving}
                  onClick={() => update({ validation_status: "invalidated", status: "rejected" })}
                >
                  验证不成立
                </button>
              </>
            )}
            {r.status !== "confirmed" && !needsValidation && (
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
              <button
                className="btn"
                disabled={saving}
                onClick={() =>
                  update(
                    isLatent && r.validation_status === "invalidated"
                      ? { status: "draft", validation_status: "unverified" }
                      : { status: "draft" },
                  )
                }
              >
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
