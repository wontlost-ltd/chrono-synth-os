/**
 * 指标查询 SQL 执行器（只读）
 */

import { registerQuery } from '../legacy-sync-bridge.js';
import {
  MTRX_QUERY_QUEUE_COUNT, MTRX_QUERY_ROLLUP_SUMMARY,
  MTRX_QUERY_BILLING_OUTBOX_COUNT, MTRX_QUERY_TENANT_USAGE,
} from '@chrono/kernel';
import type {
  MtrxCountRow, MtrxRollupRow, MtrxTenantUsageRow, MtrxTenantUsageParams,
} from '@chrono/kernel';

export function registerMetricsQueryExecutors(): void {
  registerQuery<MtrxCountRow | null, string>(MTRX_QUERY_QUEUE_COUNT, (db, status) => {
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) as count FROM tasks WHERE status = ?`,
    ).get(status);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<MtrxRollupRow | null, void>(MTRX_QUERY_ROLLUP_SUMMARY, (db) => {
    const row = db.prepare<Record<string, number | bigint | null>>(
      `SELECT
        COALESCE(SUM(runtime_completed_count), 0) AS runtime_completed_count,
        COALESCE(SUM(runtime_duration_total_ms), 0) AS runtime_duration_total_ms,
        COALESCE(SUM(task_terminal_count), 0) AS task_terminal_count,
        COALESCE(SUM(task_success_count), 0) AS task_success_count,
        COALESCE(SUM(task_rejected_count), 0) AS task_rejected_count,
        COALESCE(SUM(task_disputed_count), 0) AS task_disputed_count,
        COALESCE(SUM(wallet_settlement_count), 0) AS wallet_settlement_count,
        COALESCE(SUM(wallet_settlement_total_amount_minor), 0) AS wallet_settlement_total_amount_minor,
        COALESCE(SUM(wallet_settlement_latency_total_ms), 0) AS wallet_settlement_latency_total_ms,
        COALESCE(SUM(governance_case_opened_count), 0) AS governance_case_opened_count,
        COALESCE(SUM(governance_case_active_count), 0) AS governance_case_active_count,
        COALESCE(SUM(governance_action_applied_count), 0) AS governance_action_applied_count,
        COALESCE(SUM(persona_growth_total), 0) AS persona_growth_total,
        COALESCE(SUM(persona_growth_event_count), 0) AS persona_growth_event_count,
        COALESCE(SUM(persona_reputation_delta_total), 0) AS persona_reputation_delta_total,
        COALESCE(MAX(updated_at), 0) AS updated_at
       FROM observability_rollups`,
    ).get();
    if (!row) return null;
    return {
      runtime_completed_count: Number(row.runtime_completed_count ?? 0),
      runtime_duration_total_ms: Number(row.runtime_duration_total_ms ?? 0),
      task_terminal_count: Number(row.task_terminal_count ?? 0),
      task_success_count: Number(row.task_success_count ?? 0),
      task_rejected_count: Number(row.task_rejected_count ?? 0),
      task_disputed_count: Number(row.task_disputed_count ?? 0),
      wallet_settlement_count: Number(row.wallet_settlement_count ?? 0),
      wallet_settlement_total_amount_minor: Number(row.wallet_settlement_total_amount_minor ?? 0),
      wallet_settlement_latency_total_ms: Number(row.wallet_settlement_latency_total_ms ?? 0),
      governance_case_opened_count: Number(row.governance_case_opened_count ?? 0),
      governance_case_active_count: Number(row.governance_case_active_count ?? 0),
      governance_action_applied_count: Number(row.governance_action_applied_count ?? 0),
      persona_growth_total: Number(row.persona_growth_total ?? 0),
      persona_growth_event_count: Number(row.persona_growth_event_count ?? 0),
      persona_reputation_delta_total: Number(row.persona_reputation_delta_total ?? 0),
      updated_at: Number(row.updated_at ?? 0),
    };
  });

  registerQuery<MtrxCountRow | null, string>(MTRX_QUERY_BILLING_OUTBOX_COUNT, (db, status) => {
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) as count FROM billing_outbox WHERE status = ?`,
    ).get(status);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly MtrxTenantUsageRow[], MtrxTenantUsageParams>(MTRX_QUERY_TENANT_USAGE, (db, p) => {
    const rows = db.prepare<{ tenant_id: string; resource: string; total: number | bigint }>(
      `SELECT tenant_id, resource, SUM(quantity) as total FROM usage_records WHERE recorded_at > ? GROUP BY tenant_id, resource ORDER BY total DESC LIMIT ?`,
    ).all(p.cutoff, p.limit);
    return rows.map(r => ({ tenant_id: r.tenant_id, resource: r.resource, total: Number(r.total) }));
  });
}
