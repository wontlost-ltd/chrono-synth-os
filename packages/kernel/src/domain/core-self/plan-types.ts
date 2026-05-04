/**
 * 计费计划定义 — 纯领域类型与查询函数
 * 零 node:* 依赖，不包含宿主环境变量引用
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

/** 预定义计划限制
 *
 *  Phase-1 SaaS（岗位人格 + 对话）业务度量：
 *    - maxPersonas / conversationMessagesPerMonth / knowledgeStorageGb / bulkImportItemsPerMonth
 *
 *  既有度量（maxSimulations / maxPaths / 等）保留以维持已发布的 simulation 业务向后兼容。
 *  注意：'pro' 计划被新计划体系替代，但保留 ID 别名指向 'starter' 以避免现有订阅 id 失效。
 */
export const KERNEL_PLANS: readonly KernelPlan[] = [
  {
    id: 'free',
    name: '免费版',
    priceMinor: 0,
    currency: 'USD',
    billingInterval: 'month',
    limits: {
      maxSimulations: 3, maxPaths: 2, llmTokensPerMonth: 10_000, rateLimitPerMinute: 60,
      maxAvatars: 2, maxMemoryNodes: 10_000,
      maxPersonas: 1, conversationMessagesPerMonth: 100, knowledgeStorageGb: 0.1, bulkImportItemsPerMonth: 50,
    },
  },
  {
    id: 'starter',
    name: 'Starter',
    priceMinor: 9900,
    currency: 'USD',
    billingInterval: 'month',
    limits: {
      maxSimulations: 50, maxPaths: 10, llmTokensPerMonth: 500_000, rateLimitPerMinute: 300,
      maxAvatars: 5, maxMemoryNodes: 100_000,
      maxPersonas: 5, conversationMessagesPerMonth: 5_000, knowledgeStorageGb: 5, bulkImportItemsPerMonth: 1_000,
    },
  },
  {
    id: 'growth',
    name: 'Growth',
    priceMinor: 49900,
    currency: 'USD',
    billingInterval: 'month',
    limits: {
      maxSimulations: 500, maxPaths: 50, llmTokensPerMonth: 5_000_000, rateLimitPerMinute: 1_500,
      maxAvatars: 25, maxMemoryNodes: 1_000_000,
      maxPersonas: 25, conversationMessagesPerMonth: 50_000, knowledgeStorageGb: 50, bulkImportItemsPerMonth: 10_000,
    },
  },
  {
    id: 'enterprise',
    name: '企业版',
    priceMinor: 0,
    currency: 'USD',
    billingInterval: 'custom',
    limits: {
      maxSimulations: -1, maxPaths: -1, llmTokensPerMonth: -1, rateLimitPerMinute: -1,
      maxAvatars: -1, maxMemoryNodes: -1,
      maxPersonas: -1, conversationMessagesPerMonth: -1, knowledgeStorageGb: -1, bulkImportItemsPerMonth: -1,
    },
  },
  /* Legacy 'pro' plan：保留以兼容历史订阅与 billing_invoices.plan_id FK；
   * limits 继承 starter，价格保留 4900 以维持现有发票金额验收。
   * 新订阅请用 'starter'。 */
  {
    id: 'pro',
    name: '专业版（Legacy，等同 Starter）',
    priceMinor: 4900,
    currency: 'USD',
    billingInterval: 'month',
    limits: {
      maxSimulations: 50, maxPaths: 10, llmTokensPerMonth: 500_000, rateLimitPerMinute: 300,
      maxAvatars: 5, maxMemoryNodes: 100_000,
      maxPersonas: 5, conversationMessagesPerMonth: 5_000, knowledgeStorageGb: 5, bulkImportItemsPerMonth: 1_000,
    },
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
