/**
 * 权益服务 — 薄适配器，委托 kernel 领域逻辑
 * SQL 查询留在宿主层，纯计算委托 mergeEffectiveLimits
 */

import type { IDatabase } from '../storage/database.js';
import { getPlanLimits } from './plans.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';
import {
  mergeEffectiveLimits, RESOURCE_TO_LIMIT,
} from '@chrono/kernel';
import type { EffectiveLimits, AddOnQuota } from '@chrono/kernel';

export type { EffectiveLimits };

interface TenantAddOnRow {
  readonly resource: string;
  readonly quota_amount: number;
}

interface SubscriptionRow {
  readonly plan_id: string;
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

    /* 查询活跃附加组件的配额叠加 */
    const addOnRows = this.db.prepare<TenantAddOnRow>(
      `SELECT a.resource, a.quota_amount
       FROM tenant_add_ons ta
       JOIN add_ons a ON a.id = ta.add_on_id
       WHERE ta.tenant_id = ? AND ta.status = 'active'`,
    ).all(tenantId);

    const addOns: AddOnQuota[] = addOnRows.map(r => ({
      resource: r.resource,
      quotaAmount: r.quota_amount,
    }));

    return mergeEffectiveLimits(planLimits, addOns);
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
