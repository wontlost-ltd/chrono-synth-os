/**
 * 指标查询 Query kind 常量与参数类型（只读服务）
 */

import type { Query } from '../../ports/query.js';

/* ── Query Kinds ── */

export const MTRX_QUERY_QUEUE_COUNT = 'metrics.queueCount' as const;
export const MTRX_QUERY_ROLLUP_SUMMARY = 'metrics.rollupSummary' as const;
export const MTRX_QUERY_BILLING_OUTBOX_COUNT = 'metrics.billingOutboxCount' as const;
export const MTRX_QUERY_TENANT_USAGE = 'metrics.tenantUsage' as const;
/**
 * 跨 shard scatter-gather 专用：**无 ORDER/LIMIT** 的租户用量原始聚合。
 * 单库路径仍用带 limit 的 `MTRX_QUERY_TENANT_USAGE`（各 shard 各截断会漏「跨 shard 求和后应进 Top-N」
 * 的租户）；scatter-gather 下各 shard 拉全量原始行，由协调层全局 merge(同 tenant+resource SUM)+sort+limit。
 */
export const MTRX_QUERY_TENANT_USAGE_RAW = 'metrics.tenantUsageRaw' as const;

/* ── 行类型 ── */

export interface MtrxCountRow {
  readonly count: number;
}

export interface MtrxRollupRow {
  readonly runtime_completed_count: number;
  readonly runtime_duration_total_ms: number;
  readonly task_terminal_count: number;
  readonly task_success_count: number;
  readonly task_rejected_count: number;
  readonly task_disputed_count: number;
  readonly wallet_settlement_count: number;
  readonly wallet_settlement_total_amount_minor: number;
  readonly wallet_settlement_latency_total_ms: number;
  readonly governance_case_opened_count: number;
  readonly governance_case_active_count: number;
  readonly governance_action_applied_count: number;
  readonly persona_growth_total: number;
  readonly persona_growth_event_count: number;
  readonly persona_reputation_delta_total: number;
  readonly updated_at: number;
}

export interface MtrxTenantUsageRow {
  readonly tenant_id: string;
  readonly resource: string;
  readonly total: number;
}

/* ── 参数类型 ── */

export interface MtrxTenantUsageParams {
  cutoff: number;
  limit: number;
}

/** 无 limit 的 raw 变体参数（仅 cutoff；limit 由协调层全局施加）。 */
export interface MtrxTenantUsageRawParams {
  cutoff: number;
}

/* ── Query 工厂 ── */

export function mtrxQueryQueueCount(status: string): Query<MtrxCountRow | null, string> {
  return { kind: MTRX_QUERY_QUEUE_COUNT, params: status };
}

export function mtrxQueryRollupSummary(): Query<MtrxRollupRow | null, void> {
  return { kind: MTRX_QUERY_ROLLUP_SUMMARY, params: undefined as unknown as void };
}

export function mtrxQueryBillingOutboxCount(status: string): Query<MtrxCountRow | null, string> {
  return { kind: MTRX_QUERY_BILLING_OUTBOX_COUNT, params: status };
}

export function mtrxQueryTenantUsage(params: MtrxTenantUsageParams): Query<MtrxTenantUsageRow, MtrxTenantUsageParams> {
  return { kind: MTRX_QUERY_TENANT_USAGE, params };
}

/** 无 limit 的 raw 变体：各 shard 拉全量 (tenant, resource, total) 原始行，供协调层全局 merge+sort+limit。 */
export function mtrxQueryTenantUsageRaw(params: MtrxTenantUsageRawParams): Query<MtrxTenantUsageRow, MtrxTenantUsageRawParams> {
  return { kind: MTRX_QUERY_TENANT_USAGE_RAW, params };
}
