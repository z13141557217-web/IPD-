/**
 * 预览版：数据放在页面内存里（带一个示例项目），不调用模型。
 * 用途是让人不装任何东西就能点开界面看流程。
 */
import type { Api } from "../api";
import { createLocalBackend } from "../core/localBackend";
import { MemoryPersistence } from "../core/persistence";
import { seedInputs, seedProjects, seedRequirements } from "./seed";

// 写成函数而不是模块级的常量：别的构建方式不调用它，打包时示例数据就不会被带进去。
export function createDemoApi(): Api {
  const memory = new MemoryPersistence({
    projects: seedProjects,
    inputs: seedInputs,
    requirements: seedRequirements,
  });
  return createLocalBackend({
    version: `${__APP_VERSION__}（预览）`,
    persistence: async () => memory,
    llm: null,
    llmInfo: { provider: "mock", label: "" },
    delayMs: 200,
  });
}
