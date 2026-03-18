/**
 * 配额管理 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const QUOTA_QUERY_LIMIT = 'quota.limit' as const;
export const QUOTA_QUERY_USAGE = 'quota.usage' as const;

/* ── Command Kinds ── */

export const QUOTA_CMD_SET_LIMIT = 'quota.setLimit' as const;
export const QUOTA_CMD_CLEAR_LIMIT = 'quota.clearLimit' as const;
export const QUOTA_CMD_CONSUME = 'quota.consume' as const;
export const QUOTA_CMD_RECORD_USAGE = 'quota.recordUsage' as const;

/* ── 行类型 ── */

export interface QuotaLimitRow {
  tenant_id: string;
  resource: string;
  max_per_window: number;
  window_ms: number;
}

export interface QuotaUsageRow {
  tenant_id: string;
  resource: string;
  used: number;
  window_start: number;
}

/* ── 参数类型 ── */

export interface QuotaLimitLookupParams {
  tenantId: string;
  resource: string;
}

export interface QuotaUsageLookupParams {
  tenantId: string;
  resource: string;
  windowStart: number;
}

export interface QuotaSetLimitParams {
  tenantId: string;
  resource: string;
  maxPerWindow: number;
  windowMs: number;
}

export interface QuotaClearLimitParams {
  tenantId: string;
  resource: string;
}

export interface QuotaConsumeParams {
  tenantId: string;
  resource: string;
  quantity: number;
  windowStart: number;
  maxPerWindow: number;
}

export interface QuotaRecordUsageParams {
  tenantId: string;
  resource: string;
  quantity: number;
  windowStart: number;
}

/* ── Query 工厂 ── */

export function quotaQueryLimit(tenantId: string, resource: string): Query<QuotaLimitRow | null, QuotaLimitLookupParams> {
  return { kind: QUOTA_QUERY_LIMIT, params: { tenantId, resource } };
}

export function quotaQueryUsage(tenantId: string, resource: string, windowStart: number): Query<QuotaUsageRow | null, QuotaUsageLookupParams> {
  return { kind: QUOTA_QUERY_USAGE, params: { tenantId, resource, windowStart } };
}

/* ── Command 工厂 ── */

export function quotaCmdSetLimit(params: QuotaSetLimitParams): Command<QuotaSetLimitParams> {
  return { kind: QUOTA_CMD_SET_LIMIT, params };
}

export function quotaCmdClearLimit(params: QuotaClearLimitParams): Command<QuotaClearLimitParams> {
  return { kind: QUOTA_CMD_CLEAR_LIMIT, params };
}

export function quotaCmdConsume(params: QuotaConsumeParams): Command<QuotaConsumeParams> {
  return { kind: QUOTA_CMD_CONSUME, params };
}

export function quotaCmdRecordUsage(params: QuotaRecordUsageParams): Command<QuotaRecordUsageParams> {
  return { kind: QUOTA_CMD_RECORD_USAGE, params };
}
