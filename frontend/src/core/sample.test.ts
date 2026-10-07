import { describe, expect, it } from "vitest";

import { createLocalBackend } from "./localBackend";
import { MemoryPersistence } from "./persistence";
import { buildSample, SAMPLE_ID_COUNT, tryMaterials } from "./sample";

const NOW = "2026-10-07T00:00:00.000Z";

describe("演示项目的内容", () => {
  it("编号连续、互不重复，正好用掉预留的那一段", () => {
    const { project, inputs, requirements } = buildSample(50, NOW);
    const ids = [project.id, ...inputs.map((i) => i.id), ...requirements.map((r) => r.id)];
    expect(ids).toEqual(Array.from({ length: SAMPLE_ID_COUNT }, (_, i) => 50 + i));
    expect(project.is_sample).toBe(true);
  });

  it("引用都换成了这一份里的真实编号", () => {
    const { project, inputs, requirements } = buildSample(50, NOW);
    const requirementIds = new Set(requirements.map((r) => r.id));
    const inputIds = new Set(inputs.map((i) => i.id));
    for (const r of requirements) {
      expect(r.project_id).toBe(project.id);
      if (r.kind === "latent") {
        expect(r.based_on.length).toBeGreaterThan(0);
        expect(r.input_id).toBeNull();
      } else {
        expect(inputIds.has(r.input_id!)).toBe(true);
        // 客户提出的需求，原文必须真的能在材料里找到。
        expect(r.quote_verified).toBe(true);
      }
      for (const id of r.based_on) expect(requirementIds.has(id)).toBe(true);
      if (r.duplicate_of_id !== null) expect(requirementIds.has(r.duplicate_of_id)).toBe(true);
    }
    expect(requirements.some((r) => r.duplicate_of_id !== null)).toBe(true);
    expect(new Set(requirements.map((r) => r.status))).toEqual(new Set(["draft", "confirmed", "rejected"]));
  });

  it("备有演示用的材料", () => {
    expect(tryMaterials.length).toBeGreaterThan(0);
    for (const m of tryMaterials) expect(m.content.trim()).not.toBe("");
  });
});

describe("载入演示项目", () => {
  function backend(llm: ((prompt: string) => Promise<string>) | null = null) {
    const memory = new MemoryPersistence();
    return createLocalBackend({
      version: "test",
      persistence: async () => memory,
      llm,
      llmInfo: { provider: "hosted", label: "Claude" },
    });
  }

  it("载入后是一个带标记的普通项目，内容齐全", async () => {
    const api = backend();
    const project = await api.createSampleProject();
    expect(project.is_sample).toBe(true);
    expect((await api.listProjects()).map((p) => p.id)).toEqual([project.id]);
    const requirements = await api.listRequirements(project.id);
    expect(requirements.length).toBe(buildSample(1, NOW).requirements.length);
    expect((await api.listInputs(project.id)).every((i) => i.status === "processed")).toBe(true);
  });

  it("载入两次得到两份互不相干的项目", async () => {
    const api = backend();
    const first = await api.createSampleProject();
    const second = await api.createSampleProject();
    const a = new Set((await api.listRequirements(first.id)).map((r) => r.id));
    for (const r of await api.listRequirements(second.id)) {
      expect(a.has(r.id)).toBe(false);
      for (const id of r.based_on) expect(a.has(id)).toBe(false);
    }
    await api.deleteProject(first.id);
    expect((await api.listRequirements(second.id)).length).toBe(a.size);
  });

  it("和正式项目一样可以合并、确认、改名，并用模型分析新材料", async () => {
    const material = tryMaterials[0];
    const quote = material.content.split("\n")[0];
    const api = backend(async () =>
      JSON.stringify({ requirements: [{ title: "模型分析出的需求", source_quote: quote, disposition: "current" }] }),
    );
    const project = await api.createSampleProject();
    const before = await api.listRequirements(project.id);

    const result = await api.submitInput(project.id, material.content, material.source_type, material.requester);
    expect(result.input.status).toBe("processed");
    expect(result.requirements.map((r) => r.title)).toEqual(["模型分析出的需求"]);
    expect(result.requirements[0].quote_verified).toBe(true);

    const duplicate = before.find((r) => r.duplicate_of_id !== null)!;
    const { target } = await api.mergeRequirement(duplicate.id, duplicate.duplicate_of_id!);
    expect(target.mention_count).toBe(2);
    expect((await api.updateRequirement(target.id, { status: "confirmed" })).status).toBe("confirmed");

    // 改名之后仍然是演示项目。
    expect((await api.updateProject(project.id, { name: "改了名" })).is_sample).toBe(true);
  });
});
