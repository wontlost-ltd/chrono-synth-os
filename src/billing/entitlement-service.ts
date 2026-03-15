/**
 * 权益服务
 * 合并基础计划配额与已购附加组件，计算租户有效配额限制
 */

import type { IDatabase } from '../storage/database.js';
import { getPlanLimits, type PlanLimits } from './plans.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';

interface TenantAddOnRow {
  readonly resource: string;
  readonly quota_amount: number;
}

interface SubscriptionRow {
  readonly plan_id: string;
}

/** 资源 → PlanLimits 字段映射 */
const RESOURCE_TO_LIMIT: ReadonlyMap<string, keyof PlanLimits> = new Map([
  ['simulation', 'maxSimulations'],
  ['llm_tokens', 'llmTokensPerMonth'],
  ['memory_nodes', 'maxMemoryNodes'],
]);

export interface EffectiveLimits {
  readonly [resource: string]: number;
}

export class EntitlementService {
  constructor(private readonly db: IDatabase) {}

  /** 计算租户的有效配额限制（基础计划 + 附加组件叠加） */
  computeEffectiveLimits(tenantId: string): EffectiveLimits {
    /* 获取当前计划 */
    const sub = this.db.prepare<SubscriptionRow>(
      'SELECT plan_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);
    const planId = sub?.plan_id ?? 'free';
    const planLimits = getPlanLimits(planId);

    /* 初始化基础配额 */
    const limits: Record<string, number> = {};
    for (const [resource, field] of RESOURCE_TO_LIMIT) {
      limits[resource] = planLimits[field];
    }

    /* 查询活跃附加组件的配额叠加 */
    const addOns = this.db.prepare<TenantAddOnRow>(
      `SELECT a.resource, a.quota_amount
       FROM tenant_add_ons ta
       JOIN add_ons a ON a.id = ta.add_on_id
       WHERE ta.tenant_id = ? AND ta.status = 'active'`,
    ).all(tenantId);

    for (const addon of addOns) {
      if (addon.resource in limits) {
        const base = limits[addon.resource];
        /* -1 表示无限制，叠加后仍无限 */
        if (base < 0) continue;
        limits[addon.resource] = base + addon.quota_amount;
      } else {
        /* 非标准资源（如 advanced_models, priority_queue）直接写入 */
        limits[addon.resource] = (limits[addon.resource] ?? 0) + addon.quota_amount;
      }
    }

    return limits;
  }

  /**
   * 同步租户权益到 entitlements 表 + QuotaManager。
   * 内部操作为多条独立 SQL，无需自行开启事务。
   * 如需事务保护，由调用方在外层包裹 db.transaction()。
   */
  syncTenantEntitlements(tenantId: string): EffectiveLimits {
    const limits = this.computeEffectiveLimits(tenantId);
    const now = Date.now();
    const qm = new QuotaManager(this.db);
    const monthMs = 30 * 24 * 60 * 60 * 1000;

    for (const [resource, limit] of Object.entries(limits)) {
      /* 更新 entitlements 表 */
      this.db.prepare<void>(
        `INSERT INTO entitlements (tenant_id, resource, effective_limit, source, updated_at)
         VALUES (?, ?, ?, 'computed', ?)
         ON CONFLICT(tenant_id, resource) DO UPDATE SET effective_limit=excluded.effective_limit, source=excluded.source, updated_at=excluded.updated_at`,
      ).run(tenantId, resource, limit, now);

      /* 同步 QuotaManager */
      if (RESOURCE_TO_LIMIT.has(resource)) {
        if (limit < 0) {
          qm.clearLimit(tenantId, resource);
        } else {
          qm.setLimit(tenantId, resource, limit, monthMs);
        }
      }
    }

    return limits;
  }

  /** 获取租户的活跃附加组件列表 */
  getActiveTenantAddOns(tenantId: string): Array<{ addOnId: string; resource: string; quotaAmount: number }> {
    return this.db.prepare<{ add_on_id: string; resource: string; quota_amount: number }>(
      `SELECT ta.add_on_id, a.resource, a.quota_amount
       FROM tenant_add_ons ta
       JOIN add_ons a ON a.id = ta.add_on_id
       WHERE ta.tenant_id = ? AND ta.status = 'active'`,
    ).all(tenantId).map(r => ({
      addOnId: r.add_on_id,
      resource: r.resource,
      quotaAmount: r.quota_amount,
    }));
  }
}
