/**
 * 权益计算 — 纯领域逻辑
 * 合并基础计划配额与附加组件增量，输出有效配额
 * 零 node:* 依赖
 */

import type { PlanLimits } from './entitlement.js';

/** 有效配额映射：资源名 → 数值（-1 表示无限制） */
export interface EffectiveLimits {
  readonly [resource: string]: number;
}

/** 附加组件配额增量 */
export interface AddOnQuota {
  readonly resource: string;
  readonly quotaAmount: number;
}

/** 资源名 → PlanLimits 字段映射 */
export const RESOURCE_TO_LIMIT: ReadonlyMap<string, keyof PlanLimits> = new Map([
  ['simulation', 'maxSimulations'],
  ['llm_tokens', 'llmTokensPerMonth'],
  ['memory_nodes', 'maxMemoryNodes'],
]);

/**
 * 将 PlanLimits 展开为资源名 → 数值的映射
 * 仅包含 RESOURCE_TO_LIMIT 中定义的标准资源
 */
export function planLimitsToResourceMap(planLimits: PlanLimits): Record<string, number> {
  const limits = Object.create(null) as Record<string, number>;
  for (const [resource, field] of RESOURCE_TO_LIMIT) {
    limits[resource] = planLimits[field];
  }
  return limits;
}

/**
 * 合并基础计划配额与附加组件增量，计算有效配额
 * 规则：-1（无限制）叠加任何值仍为无限制
 */
export function mergeEffectiveLimits(
  planLimits: PlanLimits,
  addOns: readonly AddOnQuota[],
): EffectiveLimits {
  const limits = planLimitsToResourceMap(planLimits);

  for (const addon of addOns) {
    if (Object.prototype.hasOwnProperty.call(limits, addon.resource)) {
      const base = limits[addon.resource];
      /* -1 表示无限制，叠加后仍无限 */
      if (base < 0) continue;
      limits[addon.resource] = base + addon.quotaAmount;
    } else {
      /* 非标准资源（如 advanced_models, priority_queue）直接写入 */
      limits[addon.resource] = (limits[addon.resource] ?? 0) + addon.quotaAmount;
    }
  }

  return limits;
}
