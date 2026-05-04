/**
 * 订阅状态闸门（P1-D 加固 6）
 *
 * 在受保护的高价端点（POST /conversations/messages 等）调用前判定：
 *   - active / trialing → 放行
 *   - past_due 且在 grace_period_ends_at 之前 → 放行（同时审计标记）
 *   - past_due 且 grace 已过 → 拒绝（402 Payment Required）
 *   - canceled → 仅当 plan='free' 且月用量 < free quota 时放行；否则拒绝
 *   - 无 subscription 行 → 视为 free 计划，受 free quota 限制
 *
 * 路由层据此返回 402 + actionable upgradeUrl，前端可引导到 /billing/checkout。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { subqQueryGateLatest, usageQueryGet, type SubqGateRow } from '@chrono/kernel';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getPlanLimits } from './plans.js';

export type GateDecision =
  | { allowed: true; reason: 'active' | 'trialing' | 'past_due_within_grace' | 'free_within_quota' }
  | { allowed: false; statusCode: 402 | 403; reason: string; upgradeUrl: string };

type SubscriptionRow = SubqGateRow;

const RESOURCE_KEYS = {
  conversation_message: 'conversationMessagesPerMonth',
  bulk_knowledge_import_item: 'bulkImportItemsPerMonth',
} as const;

export type GateResource = keyof typeof RESOURCE_KEYS;

export class SubscriptionGateService {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
  }

  canUseResource(tenantId: string, resource: GateResource, now = Date.now()): GateDecision {
    const sub = this.findLatestSubscription(tenantId);

    /* 无订阅行 → 默认 free 计划 */
    if (!sub) {
      return this.checkFreeQuota(tenantId, resource, 'free', now);
    }

    if (sub.status === 'active' || sub.status === 'trialing') {
      return { allowed: true, reason: sub.status };
    }

    if (sub.status === 'past_due') {
      const grace = sub.grace_period_ends_at;
      if (grace !== null && grace > now) {
        return { allowed: true, reason: 'past_due_within_grace' };
      }
      return {
        allowed: false,
        statusCode: 402,
        reason: 'past_due_grace_expired',
        upgradeUrl: '/billing/portal',
      };
    }

    /* canceled 或其它非活跃状态：只允许 free quota 范围 */
    return this.checkFreeQuota(tenantId, resource, sub.plan_id, now);
  }

  private checkFreeQuota(
    tenantId: string,
    resource: GateResource,
    currentPlanId: string,
    now: number,
  ): GateDecision {
    /* 在 canceled 后我们用 free 限制（即使 plan_id 还指向旧付费计划）。
     * active/trialing 已在上层放行，不会走到这里。 */
    const effectivePlanId = currentPlanId === 'free' ? currentPlanId : 'free';
    const limits = getPlanLimits(effectivePlanId);
    const limitField = RESOURCE_KEYS[resource];
    const limit = limits[limitField] as number;

    if (limit < 0) {
      return { allowed: true, reason: 'free_within_quota' };
    }
    if (limit === 0) {
      return {
        allowed: false,
        statusCode: 402,
        reason: 'free_plan_resource_disabled',
        upgradeUrl: '/billing/checkout',
      };
    }

    const usage = this.countMonthlyUsage(tenantId, resource, now);
    if (usage >= limit) {
      return {
        allowed: false,
        statusCode: 402,
        reason: 'free_quota_exceeded',
        upgradeUrl: '/billing/checkout',
      };
    }
    return { allowed: true, reason: 'free_within_quota' };
  }

  private findLatestSubscription(tenantId: string): SubscriptionRow | null {
    return this.tx.queryOne(subqQueryGateLatest(tenantId));
  }

  private countMonthlyUsage(tenantId: string, resource: GateResource, now: number): number {
    const monthStart = now - 30 * 24 * 60 * 60 * 1000;
    const row = this.tx.queryOne(usageQueryGet(tenantId, resource, monthStart));
    return Number(row?.total ?? 0);
  }
}
