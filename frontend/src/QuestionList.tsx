import { useState } from "react";

import type { Requirement, RequirementPatch } from "./api";

interface Props {
  projectName: string;
  requirements: Requirement[];
  onUpdate: (id: number, patch: RequirementPatch) => Promise<void>;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（例如内网用 http 访问）没有剪贴板接口，退回旧办法。
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** 所有还没问到答案的问题，按需求分组，方便整份带去问客户。 */
export default function QuestionList({ projectName, requirements, onUpdate }: Props) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const withQuestions = requirements.filter(
    (r) => r.status !== "rejected" && r.open_questions.length > 0,
  );

  if (withQuestions.length === 0) {
    return <p className="empty">没有需要追问的问题。新材料分析后，把握不高的推断会在这里列出要问客户什么。</p>;
  }

  async function copyAll() {
    const lines = [`${projectName}：需要向客户确认的问题`, ""];
    withQuestions.forEach((r, i) => {
      lines.push(`${i + 1}. 关于“${r.title}”`);
      r.open_questions.forEach((q) => lines.push(`   - ${q}`));
    });
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
    </div>
  );
}
