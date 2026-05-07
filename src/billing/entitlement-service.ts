/**
 * 权益服务 — 薄适配器，委托 kernel 领域逻辑
 * SQL 由执行器层实现，纯计算委托 mergeEffectiveLimits
 */

import type { SyncWriteUnitOfWork, AddOnQuota } from '@chrono/kernel';
import { getPlanLimits } from './plans.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';
import {
  mergeEffectiveLimits, RESOURCE_TO_LIMIT,
  entlQueryPlanId, entlQueryAddOnQuotas, entlQueryActiveTenantAddons,
  entlCmdUpsert,
} from '@chrono/kernel';
import type { EffectiveLimits } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type { EffectiveLimits };

export class EntitlementService {
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  /** 计算租户的有效配额限制（基础计划 + 附加组件叠加） */
  computeEffectiveLimits(tenantId: string): EffectiveLimits {
    /* 获取当前计划 */
    const sub = this.tx.queryOne(entlQueryPlanId(tenantId));
    const planId = sub?.plan_id ?? 'free';
    const planLimits = getPlanLimits(planId);

    /* 查询活跃附加组件的配额叠加 */
    const addOnRows = this.tx.queryMany(entlQueryAddOnQuotas(tenantId));

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
    const qm = new QuotaManager(this.tx);
    const monthMs = 30 * 24 * 60 * 60 * 1000;

    for (const [resource, limit] of Object.entries(limits)) {
      /* 更新 entitlements 表 */
      this.tx.execute(entlCmdUpsert({
        tenantId,
        resource,
        effectiveLimit: limit,
        now,
      }));

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
    const rows = this.tx.queryMany(entlQueryActiveTenantAddons(tenantId));
    return rows.map(r => ({
      addOnId: r.add_on_id,
      resource: r.resource,
      quotaAmount: r.quota_amount,
    }));
  }
}
