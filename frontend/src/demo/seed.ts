/** 预览版一打开就有的示例数据：就是演示项目。分析内容是事先写好的，不是模型的输出。 */
import { buildSample } from "../core/sample";

export function buildSeed() {
  const { project, inputs, requirements } = buildSample(1, new Date().toISOString());
  return { projects: [project], inputs, requirements };
}
