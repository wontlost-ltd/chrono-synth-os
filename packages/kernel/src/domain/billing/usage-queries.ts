/**
 * 用量追踪 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const USAGE_QUERY_GET = 'usage.get' as const;
export const USAGE_QUERY_SUMMARY = 'usage.summary' as const;

/* ── Command Kinds ── */

export const USAGE_CMD_RECORD = 'usage.record' as const;

/* ── 参数类型 ── */

export interface UsageGetParams {
  tenantId: string;
  resource: string;
  since: number;
}

export interface UsageSummaryParams {
  tenantId: string;
  since: number;
}

export interface UsageRecordParams {
  id: string;
  tenantId: string;
  resource: string;
  quantity: number;
  now: number;
}

/* ── Query 工厂 ── */

export function usageQueryGet(tenantId: string, resource: string, since: number): Query<{ total: number } | null, UsageGetParams> {
  return { kind: USAGE_QUERY_GET, params: { tenantId, resource, since } };
}

export function usageQuerySummary(tenantId: string, since: number): Query<{ resource: string; total: number }, UsageSummaryParams> {
  return { kind: USAGE_QUERY_SUMMARY, params: { tenantId, since } };
}

/* ── Command 工厂 ── */

export function usageCmdRecord(params: UsageRecordParams): Command<UsageRecordParams> {
  return { kind: USAGE_CMD_RECORD, params };
}
