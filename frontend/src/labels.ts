import type { ClassificationRules, Requirement } from "./api";

/** 质量属性或设计约束的具体名称；功能性或未分类的需求返回 null。 */
export function subcategoryName(r: Requirement, rules: ClassificationRules | null): string | null {
  if (!rules || !r.subcategory) return null;
  const list = r.category === "quality" ? rules.quality_attributes : rules.constraints;
  return list.find((x) => x.key === r.subcategory)?.name ?? null;
}

export function categoryName(r: Requirement, rules: ClassificationRules | null): string {
  if (r.category === "unknown") return "类别未定";
  return rules?.categories.find((c) => c.key === r.category)?.name ?? r.category;
}

/** 折叠行上显示的类别标签。功能性需求是默认情况，不显示，让非功能需求更显眼。 */
export function categoryTag(r: Requirement, rules: ClassificationRules | null): string | null {
  if (r.category === "quality" || r.category === "constraint") {
    return subcategoryName(r, rules) ?? categoryName(r, rules);
  }
  return null;
}

export function dispositionName(r: Requirement, rules: ClassificationRules | null): string {
  if (r.disposition === "undecided") return "去向未定";
  return rules?.dispositions.find((d) => d.key === r.disposition)?.name ?? r.disposition;
}

export async function copyText(text: string): Promise<boolean> {
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
