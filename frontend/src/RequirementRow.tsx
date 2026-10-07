import { useState } from "react";

import type {
  AppealsDimension,
  Confidence,
  DemandType,
  Priority,
  Requirement,
  RequirementPatch,
  ValidationStatus,
} from "./api";

const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const STATUS_LABEL = { draft: "待确认", confirmed: "已确认", rejected: "已否决" } as const;
const DEMAND_LABEL: Record<DemandType, string> = {
  strategic: "长期需求",
  project: "单次项目",
  unknown: "类型未定",
};
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "把握高，材料直接说明了原因",
  medium: "把握中，有线索但含推断",
  low: "把握低，材料信息不足，主要是推测",
};
const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  unverified: "未验证",
  validated: "已验证成立",
  invalidated: "验证不成立",
};

interface Props {
  requirement: Requirement;
  dimensions: AppealsDimension[];
  defaultOpen: boolean;
  onUpdate: (id: number, patch: RequirementPatch) => Promise<void>;
}

export default function RequirementRow({ requirement: r, dimensions, defaultOpen, onUpdate }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [description, setDescription] = useState(r.description);
  const [saving, setSaving] = useState(false);

  const isLatent = r.kind === "latent";
  const needsValidation = isLatent && r.validation_status !== "validated";
  const dimension = dimensions.find((d) => d.key === r.appeals);
  const bodyId = `req-body-${r.id}`;

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
    <article className={`row row-${r.status}${isLatent ? " row-latent" : ""}${open ? " row-open" : ""}`}>
      <button
        type="button"
        className="row-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="row-id">#{r.id}</span>
        <span className="row-title">{r.title}</span>
        <span className="row-tags">
          {isLatent && <span className="tag tag-inferred">假设</span>}
          {r.demand_type === "strategic" && <span className="tag">长期需求</span>}
          {dimension && <span className="tag">{dimension.name}</span>}
          {r.priority === "high" && <span className="tag tag-strong">优先级高</span>}
          {!isLatent && r.confidence === "low" && <span className="tag tag-warn">把握低</span>}
          {!isLatent && r.source_quote && !r.quote_verified && (
            <span className="tag tag-bad">原文存疑</span>
          )}
          {r.duplicate_of_id !== null && <span className="tag tag-warn">疑似重复</span>}
          {r.open_questions.length > 0 && (
            <span className="tag tag-ask">{r.open_questions.length} 个待问</span>
          )}
          <span className={`status status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
        </span>
      </button>

      {open && (
        <div className="row-body" id={bodyId}>
          {editing ? (
            <div className="edit">
              <input
                value={title}
                maxLength={300}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="需求标题"
              />
              <textarea
                value={description}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="需求说明"
              />
            </div>
          ) : (
            r.description && <p className="row-desc">{r.description}</p>
          )}

          {r.duplicate_of_id !== null && (
            <p className="note note-warn">可能与 #{r.duplicate_of_id} 重复，核对后决定是否否决。</p>
          )}

          {/* 实线框是客户说的事实，虚线框是推断。两者始终分开。 */}
          {isLatent ? (
            <>
              <section className="fact">
                <h4>依据的需求</h4>
                <p>{r.based_on.map((id) => `#${id}`).join("、")}</p>
              </section>
              <section className="inferred">
                <h4>推断</h4>
                <dl>
                  {r.reasoning && (
                    <div>
                      <dt>推理过程</dt>
                      <dd>{r.reasoning}</dd>
                    </div>
                  )}
                  {r.validation_plan && (
                    <div>
                      <dt>怎样验证</dt>
                      <dd>{r.validation_plan}</dd>
                    </div>
                  )}
                  <div>
                    <dt>验证状态</dt>
                    <dd className={`validation-${r.validation_status}`}>
                      {VALIDATION_LABEL[r.validation_status]}
                      {r.validation_status === "unverified" &&
                        "。客户没有提过这一条，验证成立后才能确认。"}
                    </dd>
                  </div>
                </dl>
              </section>
            </>
          ) : (
            <>
              <section className="fact">
                <h4>客户说的</h4>
                <blockquote>
                  {r.source_quote ? `“${r.source_quote}”` : "模型没有给出原文。"}
                  {r.source_quote && (
                    <span className={r.quote_verified ? "verify verify-ok" : "verify verify-bad"}>
                      {r.quote_verified
                        ? "已在材料中找到这句话"
                        : "材料中找不到这句话，可能被模型改写或编造"}
                    </span>
                  )}
                </blockquote>
                {r.stated_request && r.stated_request !== r.source_quote && (
                  <p className="stated">表面诉求：{r.stated_request}</p>
                )}
              </section>
              {(r.underlying_problem || r.reasoning) && (
                <section className="inferred">
                  <h4>推断</h4>
                  <dl>
                    {r.underlying_problem && (
                      <div>
                        <dt>背后要解决的问题</dt>
                        <dd>{r.underlying_problem}</dd>
                      </div>
                    )}
                    {r.reasoning && (
                      <div>
                        <dt>推理过程</dt>
                        <dd>{r.reasoning}</dd>
                      </div>
                    )}
                    <div>
                      <dt>把握程度</dt>
                      <dd className={`confidence-${r.confidence}`}>{CONFIDENCE_LABEL[r.confidence]}</dd>
                    </div>
                  </dl>
                </section>
              )}
            </>
          )}

          {r.open_questions.length > 0 && (
            <section className="ask">
              <h4>要去问客户</h4>
              <ul>
                {r.open_questions.map((q) => (
                  <li key={q}>
                    <span>{q}</span>
                    <button
                      type="button"
                      className="link"
                      disabled={saving}
                      onClick={() =>
                        update({ open_questions: r.open_questions.filter((x) => x !== q) })
                      }
                    >
                      已问到
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="fields">
            <label>
              类型
              <select
                value={r.demand_type}
                disabled={saving}
                onChange={(e) => update({ demand_type: e.target.value as DemandType })}
              >
                {(Object.keys(DEMAND_LABEL) as DemandType[]).map((t) => (
                  <option key={t} value={t}>
                    {DEMAND_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
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
            {r.priority_reason && <p className="reason">{r.priority_reason}</p>}
          </div>

          <footer className="actions">
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
                  改文字
                </button>
              </>
            )}
          </footer>
        </div>
      )}
    </article>
  );
}
