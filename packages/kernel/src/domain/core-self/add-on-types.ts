/**
 * 附加组件类型与种子数据 — 纯领域类型
 * 零 node:* 依赖
 * Stripe 等宿主特定字段由适配层注入
 */

/** 附加组件核心定义（不含宿主特定字段） */
export interface KernelAddOn {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly resource: string;
  readonly quotaAmount: number;
}

/** 默认附加组件种子数据 */
export const DEFAULT_ADD_ONS: readonly KernelAddOn[] = Object.freeze([
  Object.freeze({ code: 'extra_simulations_10', name: '额外模拟 ×10', description: '增加 10 次/月模拟配额', resource: 'simulation', quotaAmount: 10 }),
  Object.freeze({ code: 'extra_tokens_100k', name: '额外 Token 10 万', description: '增加 100K LLM Token 配额', resource: 'llm_tokens', quotaAmount: 100_000 }),
  Object.freeze({ code: 'advanced_models', name: '高级模型', description: '解锁高级 LLM 模型访问', resource: 'advanced_models', quotaAmount: 1 }),
  Object.freeze({ code: 'priority_queue', name: '优先队列', description: '模拟任务优先执行', resource: 'priority_queue', quotaAmount: 1 }),
]);

/** 通过 code 查找默认附加组件 */
export function getDefaultAddOn(code: string): KernelAddOn | undefined {
  return DEFAULT_ADD_ONS.find(a => a.code === code);
}
