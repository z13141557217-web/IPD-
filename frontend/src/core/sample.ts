/**
 * 演示项目：一套预置的材料和需求，载入后就是一个普通项目。
 *
 * 内容的唯一来源是 backend/app/rules/sample_project.yaml，这里用的是导出的副本。
 * 载入规则与 backend/app/services/sample.py 保持一致。
 */
import type { Project, RawInput } from "../api";
import data from "../generated/sample.json";
import { blankRequirement, type Stored } from "./persistence";

interface SampleRequirement extends Partial<Omit<Stored, "based_on">> {
  ref: number;
  title: string;
  input?: string;
  based_on?: number[];
  duplicate_of?: number;
}

const sample = data as unknown as {
  project: { name: string; description: string };
  inputs: { ref: string; source_type: string; requester: string; content: string }[];
  requirements: SampleRequirement[];
  try_materials: TryMaterial[];
};

/** 演示时可以一键填进输入框的材料。 */
export interface TryMaterial {
  label: string;
  source_type: string;
  requester: string;
  content: string;
}
export const tryMaterials: TryMaterial[] = sample.try_materials;

/** 载入一份演示项目需要多少个编号：项目一个，每份材料、每条需求各一个。 */
export const SAMPLE_ID_COUNT = 1 + sample.inputs.length + sample.requirements.length;

/** 用从 firstId 开始的一段连续编号，生成演示项目的全部内容。 */
export function buildSample(
  firstId: number,
  now: string,
): { project: Project; inputs: RawInput[]; requirements: Stored[] } {
  const project: Project = {
    id: firstId,
    name: sample.project.name,
    description: sample.project.description,
    dismissed_probes: [],
    is_sample: true,
  };

  const inputByRef = new Map<string, RawInput>();
  sample.inputs.forEach((item, i) => {
    inputByRef.set(item.ref, {
      id: firstId + 1 + i,
      project_id: project.id,
      source_type: item.source_type,
      requester: item.requester,
      content: item.content,
      status: "processed",
      error: null,
      created_at: now,
    });
  });

  const firstRequirementId = firstId + 1 + sample.inputs.length;
  const idByRef = new Map(sample.requirements.map((item, i) => [item.ref, firstRequirementId + i]));

  const requirements = sample.requirements.map((item): Stored => {
    const { ref, input, based_on, duplicate_of, ...fields } = item;
    const raw = input ? inputByRef.get(input) : undefined;
    return {
      ...blankRequirement(),
      ...fields,
      id: idByRef.get(ref)!,
      project_id: project.id,
      input_id: raw?.id ?? null,
      // 示例里的原文都摘自对应的材料，这里仍然实际核对一遍。
      quote_verified: Boolean(raw && fields.source_quote && raw.content.includes(fields.source_quote)),
      based_on: (based_on ?? []).map((r) => idByRef.get(r)!),
      duplicate_of_id: duplicate_of === undefined ? null : idByRef.get(duplicate_of)!,
    };
  });

  return { project, inputs: [...inputByRef.values()], requirements };
}
