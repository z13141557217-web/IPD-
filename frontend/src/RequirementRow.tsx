import { useState } from "react";

import type {
  AppealsDimension,
  Category,
  ClassificationRules,
  Confidence,
  DemandType,
  Disposition,
  Priority,
  Requirement,
  RequirementPatch,
  ValidationStatus,
} from "./api";
import { categoryName, categoryTag, subcategoryName } from "./labels";

const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const STATUS_LABEL = {
  draft: "待确认",
  confirmed: "已确认",
  rejected: "已否决",
  merged: "已合并",
} as const;
const DEMAND_LABEL: Record<DemandType, string> = {
  strategic: "长期需求",
  project: "单次项目",
  unknown: "长期或单次未定",
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
  rules: ClassificationRules | null;
  defaultOpen: boolean;
  onUpdate: (id: number, patch: RequirementPatch) => Promise<void>;
  onMerge: (id: number, targetId: number) => Promise<void>;
}

export default function RequirementRow({
  requirement: r,
  dimensions,
  rules,
  defaultOpen,
  onUpdate,
  onMerge,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [title, setTitle] = useState(r.title);
  const [description, setDescription] = useState(r.description);
  const [saving, setSaving] = useState(false);

  const isLatent = r.kind === "latent";
  const isMerged = r.status === "merged";
  const needsValidation = isLatent && r.validation_status !== "validated";
  const needsDisposition = r.disposition === "undecided";
  const dimension = dimensions.find((d) => d.key === r.appeals);
  const catTag = categoryTag(r, rules);
  const subOptions =
    r.category === "quality"
      ? (rules?.quality_attributes ?? [])
      : r.category === "constraint"
        ? (rules?.constraints ?? [])
        : [];
  const bodyId = `req-body-${r.id}`;

  async function run(action: () => Promise<void>) {
    setSaving(true);
    try {
      await action();
    } finally {
      setSaving(false);
    }
  }
  const update = (patch: RequirementPatch) => run(() => onUpdate(r.id, patch));

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

  async function reject() {
    await update({ status: "rejected", reject_reason: rejectReason.trim() });
    setRejecting(false);
  }

  // 分类写成一行字；只有要改的时候才展开成下拉框。
  const classification = [
    subcategoryName(r, rules)
      ? `${categoryName(r, rules)}（${subcategoryName(r, rules)}）`
      : categoryName(r, rules),
    DEMAND_LABEL[r.demand_type],
    dimension ? `$APPEALS ${dimension.name}` : null,
  ]
    .filter(Boolean)
    .join("，");

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
          {r.mention_count > 1 && <span className="tag tag-strong">{r.mention_count} 处提到</span>}
          {catTag && <span className="tag tag-cat">{catTag}</span>}
          {r.demand_type === "strategic" && <span className="tag">长期需求</span>}
          {r.priority === "high" && <span className="tag tag-strong">优先级高</span>}
          {!isLatent && r.confidence === "low" && <span className="tag tag-warn">把握低</span>}
          {!isLatent && r.source_quote && !r.quote_verified && (
            <span className="tag tag-bad">原文存疑</span>
          )}
          {r.duplicate_of_id !== null && !isMerged && <span className="tag tag-warn">疑似重复</span>}
          {r.open_questions.length > 0 && !isMerged && (
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

          {isMerged && (
            <p className="note">
              已并入 #{r.duplicate_of_id}。这条的原话和提出者算作那一条的又一处依据。
            </p>
          )}
          {r.duplicate_of_id !== null && !isMerged && !isLatent && (
            <p className="note note-warn">
              可能与 #{r.duplicate_of_id} 是同一件事。
              <button
                type="button"
                className="link"
                disabled={saving}
                onClick={() => void run(() => onMerge(r.id, r.duplicate_of_id as number))}
              >
                并入 #{r.duplicate_of_id}
              </button>
            </p>
          )}
          {r.status === "rejected" && r.reject_reason && (
            <p className="note">否决理由：{r.reject_reason}</p>
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
                <h4>
                  客户说的
                  {r.mention_count > 1
                    ? `（共 ${r.mention_count} 处提到${r.requesters.length > 0 ? `，来自${r.requesters.join("、")}` : ""}）`
                    : r.requesters.length > 0
                      ? `（${r.requesters[0]}）`
                      : ""}
                </h4>
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

          {r.open_questions.length > 0 && !isMerged && (
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

          {reclassifying ? (
            <div className="fields">
              <label>
                类别
                <select
                  value={r.category}
                  disabled={saving}
                  onChange={(e) => update({ category: e.target.value as Category })}
                >
                  {rules?.categories.map((c) => (
                    <option key={c.key} value={c.key} title={c.description}>
                      {c.name}
                    </option>
                  ))}
                  <option value="unknown">未定</option>
                </select>
              </label>
              {subOptions.length > 0 && (
                <label>
                  具体方面
                  <select
                    value={r.subcategory ?? ""}
                    disabled={saving}
                    onChange={(e) => update({ subcategory: e.target.value || null })}
                  >
                    <option value="">未定</option>
                    {subOptions.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                长期或单次
                <select
                  value={r.demand_type}
                  disabled={saving}
                  onChange={(e) => update({ demand_type: e.target.value as DemandType })}
                >
                  <option value="strategic">长期需求</option>
                  <option value="project">单次项目</option>
                  <option value="unknown">未定</option>
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
              <button type="button" className="link" onClick={() => setReclassifying(false)}>
                收起
              </button>
            </div>
          ) : (
            <p className="classification">
              分类：{classification}
              {!isMerged && (
                <button type="button" className="link" onClick={() => setReclassifying(true)}>
                  修改
                </button>
              )}
            </p>
          )}

          {!isMerged && (
            <div className="fields decision">
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
              <label>
                去向
                <select
                  value={r.disposition}
                  disabled={saving}
                  onChange={(e) => update({ disposition: e.target.value as Disposition })}
                >
                  {r.status !== "confirmed" && <option value="undecided">未定</option>}
                  {rules?.dispositions.map((d) => (
                    <option key={d.key} value={d.key} title={d.description}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="reason">
                {[r.priority_reason, r.disposition_reason].filter(Boolean).join(" ")}
              </p>
            </div>
          )}

          {rejecting ? (
            <div className="reject">
              <input
                autoFocus
                value={rejectReason}
                maxLength={2000}
                placeholder="否决理由，用于答复提出者（可不填）"
                aria-label="否决理由"
                onChange={(e) => setRejectReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void reject();
                  if (e.key === "Escape") setRejecting(false);
                }}
              />
              <button className="btn btn-primary" disabled={saving} onClick={() => void reject()}>
                否决
              </button>
              <button className="btn" disabled={saving} onClick={() => setRejecting(false)}>
                取消
              </button>
            </div>
          ) : (
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
                  {(r.status === "draft" || r.status === "rejected") && !needsValidation && (
                    <button
                      className="btn btn-primary"
                      disabled={saving || needsDisposition}
                      title={needsDisposition ? "先选定去向" : undefined}
                      onClick={() => update({ status: "confirmed" })}
                    >
                      确认
                    </button>
                  )}
                  {(r.status === "draft" || r.status === "confirmed") && (
                    <button className="btn" disabled={saving} onClick={() => setRejecting(true)}>
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
                      {isMerged ? "取消合并" : "退回待确认"}
                    </button>
                  )}
                  {!isMerged && (
                    <button className="btn" disabled={saving} onClick={() => setEditing(true)}>
                      改文字
                    </button>
                  )}
                  {r.status === "draft" && !needsValidation && needsDisposition && (
                    <span className="muted">选定去向后才能确认</span>
                  )}
                </>
              )}
            </footer>
          )}
        </div>
      )}
    </article>
  );
}
