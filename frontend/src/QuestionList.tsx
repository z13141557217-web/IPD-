import { useState } from "react";

import type { Requirement, RequirementPatch } from "./api";
import { copyText } from "./labels";

/** 一条需求都没有的方面，以及建议拿去问客户的问题。 */
export interface Probe {
  key: string;
  name: string;
  question: string;
}

interface Props {
  projectName: string;
  requirements: Requirement[];
  probes: Probe[];
  onUpdate: (id: number, patch: RequirementPatch) => Promise<void>;
  onDismissProbe: (key: string) => void;
}

/** 所有还没问到答案的问题，方便整份带去问客户。 */
export default function QuestionList({
  projectName,
  requirements,
  probes,
  onUpdate,
  onDismissProbe,
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const withQuestions = requirements.filter(
    (r) => r.status !== "rejected" && r.status !== "merged" && r.open_questions.length > 0,
  );

  if (withQuestions.length === 0 && probes.length === 0) {
    return (
      <p className="empty">
        没有需要追问的问题。新材料分析后，把握不高的推断和还没问到的方面会列在这里。
      </p>
    );
  }

  async function copyAll() {
    const lines = [`${projectName}：需要向客户确认的问题`, ""];
    withQuestions.forEach((r, i) => {
      lines.push(`${i + 1}. 关于“${r.title}”`);
      r.open_questions.forEach((q) => lines.push(`   - ${q}`));
    });
    if (probes.length > 0) {
      if (withQuestions.length > 0) lines.push("");
      lines.push("另外想了解：");
      probes.forEach((p) => lines.push(`- ${p.question}`));
    }
    setCopyState((await copyText(lines.join("\n"))) ? "done" : "failed");
    window.setTimeout(() => setCopyState("idle"), 2500);
  }

  return (
    <div className="questions">
      <div className="questions-head">
        <p className="muted">问到答案后，把客户的回答作为新材料录入，再点“已问到”。</p>
        <button className="btn" onClick={() => void copyAll()}>
          {copyState === "done" ? "已复制" : copyState === "failed" ? "复制失败，请手动选择" : "复制全部问题"}
        </button>
      </div>

      {withQuestions.map((r) => (
        <section key={r.id} className="question-group">
          <h3>
            <span className="row-id">#{r.id}</span> {r.title}
            {r.kind === "latent" && <span className="tag tag-inferred">假设</span>}
          </h3>
          <ul>
            {r.open_questions.map((q) => (
              <li key={q}>
                <span>{q}</span>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void onUpdate(r.id, { open_questions: r.open_questions.filter((x) => x !== q) })
                  }
                >
                  已问到
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {probes.length > 0 && (
        <section className="question-group probe-group">
          <h3>还没有问到的方面</h3>
          <p className="muted">
            这些方面目前一条需求都没有。客户很少主动提，但产品“不好用”往往出在这里。
          </p>
          <ul>
            {probes.map((p) => (
              <li key={p.key}>
                <span>
                  <span className="tag tag-cat">{p.name}</span> {p.question}
                </span>
                <button type="button" className="link" onClick={() => onDismissProbe(p.key)}>
                  问过了，客户不在意
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
