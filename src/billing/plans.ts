/**
 * 计费计划定义 — 薄适配器，委托 kernel 领域逻辑
 * Stripe price ID 由 process.env 注入
 */

import type { UowOrDb } from '../storage/uow-helpers.js';
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
  stripePriceId: resolveStripePriceId(kp.id),
}));

function resolveStripePriceId(planId: string): string {
  switch (planId) {
    case 'starter':
      return process.env.CHRONO_STRIPE_PRICE_STARTER ?? '';
    case 'growth':
      return process.env.CHRONO_STRIPE_PRICE_GROWTH ?? '';
    case 'enterprise':
      return process.env.CHRONO_STRIPE_PRICE_ENTERPRISE ?? '';
    /* legacy 别名：'pro' 映射到 starter price，避免历史订阅断裂 */
    case 'pro':
      return process.env.CHRONO_STRIPE_PRICE_PRO
        ?? process.env.CHRONO_STRIPE_PRICE_STARTER
        ?? '';
    default:
      return '';
  }
}

/** 通过 ID 查找计划 */
export function getPlan(planId: string): Plan | undefined {
  return PLANS.find(p => p.id === planId);
}

/** 获取计划限制，不存在时返回 free 计划限制 */
export function getPlanLimits(planId: string): PlanLimits {
  return getKernelPlanLimits(planId);
}

/** 将计划限制同步到 QuotaManager（设置 simulation/llm_tokens/conversation/knowledge 配额）
 *
 *  -1 表示无限制 → clearLimit；> 0 → setLimit；0 不写入（保留旧值，避免误清）
 */
export function syncPlanToQuota(uowOrDb: UowOrDb, tenantId: string, planId: string): void {
  const qm = new QuotaManager(uowOrDb);
  const limits = getPlanLimits(planId);
  const monthMs = 30 * 24 * 60 * 60 * 1000;

  const apply = (resource: string, value: number) => {
    if (value < 0) qm.clearLimit(tenantId, resource);
    else if (value > 0) qm.setLimit(tenantId, resource, value, monthMs);
  };

  /* 既有度量 */
  apply('simulation', limits.maxSimulations);
  apply('llm_tokens', limits.llmTokensPerMonth);
  apply('memory_nodes', limits.maxMemoryNodes);

  /* Phase-1 业务度量 */
  apply('conversation_message', limits.conversationMessagesPerMonth);
  apply('bulk_knowledge_import_item', limits.bulkImportItemsPerMonth);
  /* knowledge_storage_gb 与 maxPersonas 是 absolute caps（非 per-window），单独处理：
   * - knowledge_storage_gb：与 BulkImportService.processSingle 的实际字节数累计比对（应用层校验）
   * - maxPersonas：persona-template 实例化时检查（应用层校验）
   * 这里仅同步 per-window 资源到 QuotaManager。 */
}
