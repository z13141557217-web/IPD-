/**
 * 在线版：页面发布在 Claude 上，数据存到平台为这个页面提供的存储里，
 * 分析时由页面直接调用 Claude。不需要自己部署任何东西。
 */
import type { Api } from "../api";
import { createLocalBackend } from "../core/localBackend";
import { DbPersistence, type DocStore, MemoryPersistence, type Persistence } from "../core/persistence";

interface SampleError {
  code?: string;
}
type Sample = (
  input: string,
  options?: { modelTier?: "default" | "complex" | "quick" },
) => Promise<{ text: string; truncated: boolean }>;

interface ClaudeRuntime {
  use(name: "db"): Promise<DocStore | null>;
  use(name: "sample"): Promise<Sample | null>;
}

function runtime(): ClaudeRuntime | null {
  const claude = (window as unknown as { claude?: ClaudeRuntime }).claude;
  return claude && typeof claude.use === "function" ? claude : null;
}

let persistence: Promise<Persistence> | null = null;

function getPersistence(): Promise<Persistence> {
  // 平台就绪后才能知道存储是否可用；连不上时退回内存，并由界面提示数据不会保留。
  persistence ??= (async () => {
    const db = await runtime()?.use("db").catch(() => null);
    return db ? new DbPersistence(db) : new MemoryPersistence();
  })();
  return persistence;
}

const MODEL_MESSAGES: Record<string, string> = {
  not_granted: "你没有允许这个页面调用 Claude。重新打开页面，在提示时选择允许即可。",
  sampling_disabled: "你的账号或所在组织目前不能在页面里调用 Claude。",
  not_declared: "这个页面没有开启调用模型的能力，请联系页面的发布者。",
  capability_disabled: "这个页面现在不能调用模型，请换一个浏览器或更新 Claude 应用后再试。",
  capability_removed: "这个页面现在不能调用模型，请换一个浏览器或更新 Claude 应用后再试。",
  rate_limited: "调用太频繁，或者你的 Claude 用量已到上限。请过一会儿再试。",
  session_expired: "登录已过期，请重新登录 Claude 后再试。",
  refused: "模型拒绝处理这份内容。请检查材料里是否有不适合处理的内容。",
  empty_completion: "模型没有给出任何回答。可以把材料缩短一些再试。",
  prompt_too_large: "材料太长，超过了一次能处理的长度。请分成几份录入。",
  cancelled: "已取消。",
};

async function askClaude(prompt: string): Promise<string> {
  const sample = await runtime()?.use("sample").catch(() => null);
  if (!sample) {
    throw new Error("这个页面现在不能调用模型。请确认是在 Claude 里登录后打开的这个页面。");
  }
  let result;
  try {
    result = await sample(prompt);
  } catch (err) {
    const code = (err as SampleError | null)?.code ?? "";
    throw new Error(MODEL_MESSAGES[code] ?? "调用模型时出错，可能是网络或服务暂时不稳定。请稍后重试。");
  }
  if (result.truncated) {
    throw new Error("模型的回答太长，被截断了。请把材料分成几份录入。");
  }
  return result.text;
}

export function createHostedApi(): Api {
  return createLocalBackend({
    version: `${__APP_VERSION__}（在线版）`,
    persistence: getPersistence,
    llm: askClaude,
    llmInfo: { provider: "hosted", label: "Claude" },
  });
}
