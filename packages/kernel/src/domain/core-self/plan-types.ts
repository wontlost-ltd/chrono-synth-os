/**
 * 计费计划定义 — 纯领域类型与查询函数
 * 零 node:* 依赖，不包含 process.env 引用
 * Stripe price ID 等宿主特定字段由适配层注入
 */

import type { PlanLimits } from './entitlement.js';

export type BillingInterval = 'month' | 'year' | 'custom';

/** 计划定义（内核层，不含 Stripe 等宿主特定字段） */
export interface KernelPlan {
  readonly id: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingInterval: BillingInterval;
  readonly limits: PlanLimits;
}

/** 预定义计划限制 */
export const KERNEL_PLANS: readonly KernelPlan[] = [
  {
    id: 'free',
    name: '免费版',
    priceMinor: 0,
    currency: 'USD',
    billingInterval: 'month',
    limits: { maxSimulations: 3, maxPaths: 2, llmTokensPerMonth: 10_000, rateLimitPerMinute: 60, maxAvatars: 2, maxMemoryNodes: 10_000 },
  },
  {
    id: 'pro',
    name: '专业版',
    priceMinor: 4900,
    currency: 'USD',
    billingInterval: 'month',
    limits: { maxSimulations: 50, maxPaths: 10, llmTokensPerMonth: 500_000, rateLimitPerMinute: 300, maxAvatars: 5, maxMemoryNodes: 100_000 },
  },
  {
    id: 'enterprise',
    name: '企业版',
    priceMinor: 0,
    currency: 'USD',
    billingInterval: 'custom',
    limits: { maxSimulations: -1, maxPaths: -1, llmTokensPerMonth: -1, rateLimitPerMinute: -1, maxAvatars: -1, maxMemoryNodes: -1 },
  },
];

/** 通过 ID 查找计划 */
export function getKernelPlan(planId: string): KernelPlan | undefined {
  return KERNEL_PLANS.find(p => p.id === planId);
}

/** 获取计划限制，不存在时返回 free 计划限制 */
export function getKernelPlanLimits(planId: string): PlanLimits {
  const plan = getKernelPlan(planId);
  if (plan) return plan.limits;

  const freePlan = getKernelPlan('free');
  if (!freePlan) {
    throw new Error('KERNEL_PLANS must include a free plan');
  }
  return freePlan.limits;
}
