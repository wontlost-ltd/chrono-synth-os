/**
 * Metrics Query Application Service
 * 封装指标端点的 DB 聚合查询
 */

import type { IDatabase } from '../storage/database.js';
import { getObservabilityOutboxBacklog } from './observability-outbox.js';

type MetricScalar = number | bigint | string | null | undefined;

interface ObservabilitySummaryRow {
  runtime_completed_count?: MetricScalar;
  runtime_duration_total_ms?: MetricScalar;
  task_terminal_count?: MetricScalar;
  task_success_count?: MetricScalar;
  task_rejected_count?: MetricScalar;
  task_disputed_count?: MetricScalar;
  wallet_settlement_count?: MetricScalar;
  wallet_settlement_total_amount_minor?: MetricScalar;
  wallet_settlement_latency_total_ms?: MetricScalar;
  governance_case_opened_count?: MetricScalar;
  governance_case_active_count?: MetricScalar;
  governance_action_applied_count?: MetricScalar;
  persona_growth_total?: MetricScalar;
  persona_growth_event_count?: MetricScalar;
  persona_reputation_delta_total?: MetricScalar;
  updated_at?: MetricScalar;
}

export interface ObservabilitySummary {
  runtime_completed_count: number;
  runtime_duration_total_ms: number;
  task_terminal_count: number;
  task_success_count: number;
  task_rejected_count: number;
  task_disputed_count: number;
  wallet_settlement_count: number;
  wallet_settlement_total_amount_minor: number;
  wallet_settlement_latency_total_ms: number;
  governance_case_opened_count: number;
  governance_case_active_count: number;
  governance_action_applied_count: number;
  persona_growth_total: number;
  persona_growth_event_count: number;
  persona_reputation_delta_total: number;
  updated_at: number;
}

export function toMetricNumber(value: MetricScalar): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeObservabilitySummary(row?: ObservabilitySummaryRow): ObservabilitySummary {
  return {
    runtime_completed_count: toMetricNumber(row?.runtime_completed_count),
    runtime_duration_total_ms: toMetricNumber(row?.runtime_duration_total_ms),
    task_terminal_count: toMetricNumber(row?.task_terminal_count),
    task_success_count: toMetricNumber(row?.task_success_count),
    task_rejected_count: toMetricNumber(row?.task_rejected_count),
    task_disputed_count: toMetricNumber(row?.task_disputed_count),
    wallet_settlement_count: toMetricNumber(row?.wallet_settlement_count),
    wallet_settlement_total_amount_minor: toMetricNumber(row?.wallet_settlement_total_amount_minor),
    wallet_settlement_latency_total_ms: toMetricNumber(row?.wallet_settlement_latency_total_ms),
    governance_case_opened_count: toMetricNumber(row?.governance_case_opened_count),
    governance_case_active_count: toMetricNumber(row?.governance_case_active_count),
    governance_action_applied_count: toMetricNumber(row?.governance_action_applied_count),
    persona_growth_total: toMetricNumber(row?.persona_growth_total),
    persona_growth_event_count: toMetricNumber(row?.persona_growth_event_count),
    persona_reputation_delta_total: toMetricNumber(row?.persona_reputation_delta_total),
    updated_at: toMetricNumber(row?.updated_at),
  };
}

export class MetricsQueryService {
  constructor(private readonly db: IDatabase) {}

  getQueueBacklog(): { pending: number; running: number; failed: number } {
    try {
      const pending = toMetricNumber(
        this.db.prepare<{ count: MetricScalar }>(`SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'`).get()?.count,
      );
      const running = toMetricNumber(
        this.db.prepare<{ count: MetricScalar }>(`SELECT COUNT(*) as count FROM tasks WHERE status = 'running'`).get()?.count,
      );
      const failed = toMetricNumber(
        this.db.prepare<{ count: MetricScalar }>(`SELECT COUNT(*) as count FROM tasks WHERE status = 'failed'`).get()?.count,
      );
      return { pending, running, failed };
    } catch { return { pending: 0, running: 0, failed: 0 }; }
  }

  getObservabilitySummary(): { rollup: ObservabilitySummary; backlog: { pending: number; processing: number; failed: number } } {
    try {
      const rollupRow = this.db.prepare<ObservabilitySummaryRow>(
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
      const backlog = getObservabilityOutboxBacklog(this.db);
      return {
        rollup: normalizeObservabilitySummary(rollupRow),
        backlog: {
          pending: toMetricNumber(backlog.pending),
          processing: toMetricNumber(backlog.processing),
          failed: toMetricNumber(backlog.failed),
        },
      };
    } catch {
      return {
        rollup: normalizeObservabilitySummary(),
        backlog: { pending: 0, processing: 0, failed: 0 },
      };
    }
  }

  getBillingOutboxBacklog(): { pending: number; failed: number } {
    try {
      const pending = toMetricNumber(
        this.db.prepare<{ count: MetricScalar }>(`SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'pending'`).get()?.count,
      );
      const failed = toMetricNumber(
        this.db.prepare<{ count: MetricScalar }>(`SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'failed'`).get()?.count,
      );
      return { pending, failed };
    } catch { return { pending: 0, failed: 0 }; }
  }

  getTenantUsage(retentionMs: number, limit: number = 200): Array<{ tenant_id: string; resource: string; total: number }> {
    try {
      const cutoff = Date.now() - retentionMs;
      return this.db.prepare<{ tenant_id: string; resource: string; total: number }>(
        `SELECT tenant_id, resource, SUM(quantity) as total FROM usage_records WHERE recorded_at > ? GROUP BY tenant_id, resource ORDER BY total DESC LIMIT ?`,
      ).all(cutoff, limit);
    } catch { return []; }
  }
}
