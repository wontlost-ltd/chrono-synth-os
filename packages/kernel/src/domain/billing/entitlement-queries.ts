/**
 * 权益服务 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const ENTL_QUERY_PLAN_ID = 'entitlement.planId' as const;
export const ENTL_QUERY_ADD_ON_QUOTAS = 'entitlement.addOnQuotas' as const;
export const ENTL_QUERY_ACTIVE_TENANT_ADDONS = 'entitlement.activeTenantAddons' as const;

/* ── Command Kinds ── */

export const ENTL_CMD_UPSERT = 'entitlement.upsert' as const;

/* ── 行类型 ── */

export interface EntlPlanIdRow {
  readonly plan_id: string;
}

export interface EntlAddOnQuotaRow {
  readonly resource: string;
  readonly quota_amount: number;
}

export interface EntlActiveTenantAddonRow {
  readonly add_on_id: string;
  readonly resource: string;
  readonly quota_amount: number;
}

/* ── 参数类型 ── */

export interface EntlUpsertParams {
  tenantId: string;
  resource: string;
  effectiveLimit: number;
  now: number;
}

/* ── Query 工厂 ── */

export function entlQueryPlanId(tenantId: string): Query<EntlPlanIdRow | null, string> {
  return { kind: ENTL_QUERY_PLAN_ID, params: tenantId };
}

export function entlQueryAddOnQuotas(tenantId: string): Query<readonly EntlAddOnQuotaRow[], string> {
  return { kind: ENTL_QUERY_ADD_ON_QUOTAS, params: tenantId };
}

export function entlQueryActiveTenantAddons(tenantId: string): Query<readonly EntlActiveTenantAddonRow[], string> {
  return { kind: ENTL_QUERY_ACTIVE_TENANT_ADDONS, params: tenantId };
}

/* ── Command 工厂 ── */

export function entlCmdUpsert(params: EntlUpsertParams): Command<EntlUpsertParams> {
  return { kind: ENTL_CMD_UPSERT, params };
}
