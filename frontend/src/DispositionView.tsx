import { useState } from "react";

import type { ClassificationRules, Requirement } from "./api";
import { categoryTag, copyText } from "./labels";

interface Props {
  projectName: string;
  requirements: Requirement[];
  rules: ClassificationRules | null;
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" } as const;

/** 已确认的需求按去向汇总：哪些进当前版本，哪些进规划，哪些长期跟踪。 */
export default function DispositionView({ projectName, requirements, rules }: Props) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const confirmed = requirements.filter((r) => r.status === "confirmed");

  if (confirmed.length === 0) {
    return <p className="empty">还没有已确认的需求。确认需求时选定的去向会汇总在这里。</p>;
  }

  const groups = [
    ...(rules?.dispositions ?? []),
    { key: "undecided" as const, name: "去向未定", description: "早先确认时还没有选去向，需要补上。" },
  ]
    .map((d) => ({
      ...d,
      items: confirmed
        .filter((r) => r.disposition === d.key)
        .sort(
          (a, b) =>
            PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.mention_count - a.mention_count,
        ),
    }))
    .filter((g) => g.items.length > 0);

  async function copyAll() {
    const lines = [`${projectName}：已确认需求的去向`, ""];
    groups.forEach((g) => {
      lines.push(`【${g.name}】${g.items.length} 条`);
      g.items.forEach((r) => {
        const extra = [
          `优先级${PRIORITY_LABEL[r.priority]}`,
          r.mention_count > 1 ? `${r.mention_count} 处提到` : null,
        ]
          .filter(Boolean)
          .join("，");
        lines.push(`- ${r.title}（${extra}）`);
      });
      lines.push("");
    });
    setCopyState((await copyText(lines.join("\n").trimEnd())) ? "done" : "failed");
    window.setTimeout(() => setCopyState("idle"), 2500);
  }

  return (
    <div className="questions">
      <div className="questions-head">
        <p className="muted">每组内按优先级和被提到的次数排序。</p>
        <button className="btn" onClick={() => void copyAll()}>
          {copyState === "done" ? "已复制" : copyState === "failed" ? "复制失败，请手动选择" : "复制汇总"}
        </button>
      </div>
      {groups.map((g) => (
        <section key={g.key} className="question-group">
          <h3>
            {g.name} <span className="row-id">{g.items.length} 条</span>
          </h3>
          <p className="muted">{g.description}</p>
          <ul>
            {g.items.map((r) => (
              <li key={r.id}>
                <span>
                  <span className="row-id">#{r.id}</span> {r.title}
                </span>
                <span className="row-tags">
                  {r.mention_count > 1 && (
                    <span className="tag tag-strong">{r.mention_count} 处提到</span>
                  )}
                  {categoryTag(r, rules) && <span className="tag tag-cat">{categoryTag(r, rules)}</span>}
                  <span className={r.priority === "high" ? "tag tag-strong" : "tag"}>
                    优先级{PRIORITY_LABEL[r.priority]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
