import { describe, expect, it } from "vitest";

import parity from "../generated/parity.json";
import {
  buildExtractionUserPrompt,
  buildLatentUserPrompt,
  ModelOutputError,
  parseExtraction,
  parseHypotheses,
  pyJson,
} from "./analysis";

// 标准答案由后端算出（scripts/export_rules.py）。这里检查在线版的实现与后端逐字一致。

describe("拼提示词与后端一致", () => {
  it.each(parity.extract_prompt.map((c, i) => [i, c] as const))("提取需求，样例 %i", (_, c) => {
    expect(buildExtractionUserPrompt(c, c.existing, c.background)).toBe(c.expected);
  });

  it.each(parity.latent_prompt.map((c, i) => [i, c] as const))("潜在需求，样例 %i", (_, c) => {
    expect(buildLatentUserPrompt(c.stated, c.existing_latent, c.background)).toBe(c.expected);
  });
});

describe("解析模型输出与后端一致", () => {
  it.each(parity.parse_extraction.map((c, i) => [i, c] as const))("提取需求，样例 %i", (_, c) => {
    const run = () => parseExtraction(c.text, c.content, new Set(c.existing_ids));
    if ("error" in c && c.error) expect(run).toThrow(ModelOutputError);
    else expect(run()).toEqual(c.expected);
  });

  it.each(parity.parse_hypotheses.map((c, i) => [i, c] as const))("潜在需求，样例 %i", (_, c) => {
    const run = () => parseHypotheses(c.text, new Set(c.known_ids));
    if ("error" in c && c.error) expect(run).toThrow(ModelOutputError);
    else expect(run()).toEqual(c.expected);
  });
});

describe("pyJson", () => {
  it("和 Python 的 json.dumps 用同样的分隔符", () => {
    expect(pyJson([{ id: 1, title: 'a"b' }, "中文", null, true])).toBe(
      '[{"id": 1, "title": "a\\"b"}, "中文", null, true]',
    );
    expect(pyJson([])).toBe("[]");
    expect(pyJson({})).toBe("{}");
  });
});
