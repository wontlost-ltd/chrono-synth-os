/**
 * 计费计划定义 — 薄适配器，委托 kernel 领域逻辑
 * Stripe price ID 由 process.env 注入
 */

import type { IDatabase } from '../storage/database.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';
import {
  KERNEL_PLANS, getKernelPlanLimits,
} from '@chrono/kernel';
import type { PlanLimits, KernelPlan } from '@chrono/kernel';

export type { PlanLimits };

export interface Plan extends KernelPlan {
  readonly stripePriceId: string;
}

/** 预定义计划列表（注入 Stripe price ID） */
export const PLANS: readonly Plan[] = KERNEL_PLANS.map(kp => ({
  ...kp,
  stripePriceId: kp.id === 'pro'
    ? (process.env.CHRONO_STRIPE_PRICE_PRO ?? 'price_1T9NMnDVwJxh7zGN9MgSA7I9')
    : kp.id === 'enterprise'
      ? (process.env.CHRONO_STRIPE_PRICE_ENTERPRISE ?? 'price_1T9NMzDVwJxh7zGNZRWszFKH')
      : '',
}));

/** 通过 ID 查找计划 */
export function getPlan(planId: string): Plan | undefined {
  return PLANS.find(p => p.id === planId);
}

/** 获取计划限制，不存在时返回 free 计划限制 */
export function getPlanLimits(planId: string): PlanLimits {
  return getKernelPlanLimits(planId);
}

/** 将计划限制同步到 QuotaManager（设置 simulation/llm_tokens 配额） */
export function syncPlanToQuota(db: IDatabase, tenantId: string, planId: string): void {
  const qm = new QuotaManager(db);
  const limits = getPlanLimits(planId);
  const monthMs = 30 * 24 * 60 * 60 * 1000;

  if (limits.maxSimulations < 0) {
    qm.clearLimit(tenantId, 'simulation');
  } else if (limits.maxSimulations > 0) {
    qm.setLimit(tenantId, 'simulation', limits.maxSimulations, monthMs);
  }
  if (limits.llmTokensPerMonth < 0) {
    qm.clearLimit(tenantId, 'llm_tokens');
  } else if (limits.llmTokensPerMonth > 0) {
    qm.setLimit(tenantId, 'llm_tokens', limits.llmTokensPerMonth, monthMs);
  }
  if (limits.maxMemoryNodes < 0) {
    qm.clearLimit(tenantId, 'memory_nodes');
  } else if (limits.maxMemoryNodes > 0) {
    qm.setLimit(tenantId, 'memory_nodes', limits.maxMemoryNodes, monthMs);
  }
}
