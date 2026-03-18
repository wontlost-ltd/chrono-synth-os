/**
 * 权益服务 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  ENTL_QUERY_PLAN_ID, ENTL_QUERY_ADD_ON_QUOTAS, ENTL_QUERY_ACTIVE_TENANT_ADDONS,
  ENTL_CMD_UPSERT,
} from '@chrono/kernel';
import type {
  EntlPlanIdRow, EntlAddOnQuotaRow, EntlActiveTenantAddonRow,
  EntlUpsertParams,
} from '@chrono/kernel';

export function registerEntitlementExecutors(): void {
  /* ── Queries ── */

  registerQuery<EntlPlanIdRow | null, string>(ENTL_QUERY_PLAN_ID, (db, tenantId) => {
    return db.prepare<EntlPlanIdRow>(
      'SELECT plan_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId) ?? null;
  });

  registerQuery<readonly EntlAddOnQuotaRow[], string>(ENTL_QUERY_ADD_ON_QUOTAS, (db, tenantId) => {
    return db.prepare<EntlAddOnQuotaRow>(
      `SELECT a.resource, a.quota_amount
       FROM tenant_add_ons ta
       JOIN add_ons a ON a.id = ta.add_on_id
       WHERE ta.tenant_id = ? AND ta.status = 'active'`,
    ).all(tenantId);
  });

  registerQuery<readonly EntlActiveTenantAddonRow[], string>(ENTL_QUERY_ACTIVE_TENANT_ADDONS, (db, tenantId) => {
    return db.prepare<EntlActiveTenantAddonRow>(
      `SELECT ta.add_on_id, a.resource, a.quota_amount
       FROM tenant_add_ons ta
       JOIN add_ons a ON a.id = ta.add_on_id
       WHERE ta.tenant_id = ? AND ta.status = 'active'`,
    ).all(tenantId);
  });

  /* ── Commands ── */

  registerCommand<EntlUpsertParams>(ENTL_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO entitlements (tenant_id, resource, effective_limit, source, updated_at)
       VALUES (?, ?, ?, 'computed', ?)
       ON CONFLICT(tenant_id, resource) DO UPDATE SET effective_limit=excluded.effective_limit, source=excluded.source, updated_at=excluded.updated_at`,
    ).run(p.tenantId, p.resource, p.effectiveLimit, p.now);
    return { rowsAffected: result.changes };
  });
}
