/**
 * 计费计划定义
 * 定义所有可用的订阅计划及其资源限制
 */

import type { IDatabase } from '../storage/database.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';

export interface PlanLimits {
  readonly maxSimulations: number;
  readonly maxPaths: number;
  readonly llmTokensPerMonth: number;
  /** API 请求限流（每分钟最大请求数），-1 表示无限制 */
  readonly rateLimitPerMinute: number;
  /** 最大分身数量，-1 表示无限制 */
  readonly maxAvatars: number;
  /** 最大记忆节点数量，-1 表示无限制 */
  readonly maxMemoryNodes: number;
}

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly stripePriceId: string;
  readonly limits: PlanLimits;
}

/** 预定义计划列表 */
export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: '免费版',
    stripePriceId: '',
    limits: { maxSimulations: 3, maxPaths: 2, llmTokensPerMonth: 10_000, rateLimitPerMinute: 60, maxAvatars: 2, maxMemoryNodes: 10_000 },
  },
  {
    id: 'pro',
    name: '专业版',
    stripePriceId: 'price_pro_monthly',
    limits: { maxSimulations: 50, maxPaths: 10, llmTokensPerMonth: 500_000, rateLimitPerMinute: 300, maxAvatars: 5, maxMemoryNodes: 100_000 },
  },
  {
    id: 'enterprise',
    name: '企业版',
    stripePriceId: 'price_enterprise_monthly',
    limits: { maxSimulations: -1, maxPaths: -1, llmTokensPerMonth: -1, rateLimitPerMinute: -1, maxAvatars: -1, maxMemoryNodes: -1 },
  },
];

/** 通过 ID 查找计划 */
export function getPlan(planId: string): Plan | undefined {
  return PLANS.find(p => p.id === planId);
}

/** 获取计划限制，不存在时返回 free 计划限制 */
export function getPlanLimits(planId: string): PlanLimits {
  const plan = getPlan(planId);
  return plan?.limits ?? PLANS[0].limits;
}

/** 将计划限制同步到 QuotaManager（设置 simulation/llm_tokens 配额） */
export function syncPlanToQuota(db: IDatabase, tenantId: string, planId: string): void {
  const qm = new QuotaManager(db);
  const limits = getPlanLimits(planId);
  const monthMs = 30 * 24 * 60 * 60 * 1000;

  if (limits.maxSimulations < 0) {
    /* 无限计划：清除配额限制 */
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
