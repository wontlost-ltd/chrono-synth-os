/**
 * Metrics Query Application Service
 * 封装指标端点的 DB 聚合查询
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { MtrxRollupRow } from '@chrono/kernel';
import {
  mtrxQueryQueueCount, mtrxQueryRollupSummary,
  mtrxQueryBillingOutboxCount, mtrxQueryTenantUsage,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getObservabilityOutboxBacklog } from './observability-outbox.js';

type MetricScalar = number | bigint | string | null | undefined;

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

function rollupRowToSummary(row?: MtrxRollupRow | null): ObservabilitySummary {
  return {
    runtime_completed_count: row?.runtime_completed_count ?? 0,
    runtime_duration_total_ms: row?.runtime_duration_total_ms ?? 0,
    task_terminal_count: row?.task_terminal_count ?? 0,
    task_success_count: row?.task_success_count ?? 0,
    task_rejected_count: row?.task_rejected_count ?? 0,
    task_disputed_count: row?.task_disputed_count ?? 0,
    wallet_settlement_count: row?.wallet_settlement_count ?? 0,
    wallet_settlement_total_amount_minor: row?.wallet_settlement_total_amount_minor ?? 0,
    wallet_settlement_latency_total_ms: row?.wallet_settlement_latency_total_ms ?? 0,
    governance_case_opened_count: row?.governance_case_opened_count ?? 0,
    governance_case_active_count: row?.governance_case_active_count ?? 0,
    governance_action_applied_count: row?.governance_action_applied_count ?? 0,
    persona_growth_total: row?.persona_growth_total ?? 0,
    persona_growth_event_count: row?.persona_growth_event_count ?? 0,
    persona_reputation_delta_total: row?.persona_reputation_delta_total ?? 0,
    updated_at: row?.updated_at ?? 0,
  };
}

export class MetricsQueryService {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase) {
    registerCoreSelfExecutors();
    this.tx = db;
  }

  getQueueBacklog(): { pending: number; running: number; failed: number } {
    try {
      const pending = this.tx.queryOne(mtrxQueryQueueCount('pending'))?.count ?? 0;
      const running = this.tx.queryOne(mtrxQueryQueueCount('running'))?.count ?? 0;
      const failed = this.tx.queryOne(mtrxQueryQueueCount('failed'))?.count ?? 0;
      return { pending, running, failed };
    } catch { return { pending: 0, running: 0, failed: 0 }; }
  }

  getObservabilitySummary(): { rollup: ObservabilitySummary; backlog: { pending: number; processing: number; failed: number } } {
    try {
      const rollupRow = this.tx.queryOne(mtrxQueryRollupSummary());
      const backlog = getObservabilityOutboxBacklog(this.tx);
      return {
        rollup: rollupRowToSummary(rollupRow),
        backlog: {
          pending: toMetricNumber(backlog.pending),
          processing: toMetricNumber(backlog.processing),
          failed: toMetricNumber(backlog.failed),
        },
      };
    } catch {
      return {
        rollup: rollupRowToSummary(),
        backlog: { pending: 0, processing: 0, failed: 0 },
      };
    }
  }

  getBillingOutboxBacklog(): { pending: number; failed: number } {
    try {
      const pending = this.tx.queryOne(mtrxQueryBillingOutboxCount('pending'))?.count ?? 0;
      const failed = this.tx.queryOne(mtrxQueryBillingOutboxCount('failed'))?.count ?? 0;
      return { pending, failed };
    } catch { return { pending: 0, failed: 0 }; }
  }

  getTenantUsage(retentionMs: number, limit: number = 200): Array<{ tenant_id: string; resource: string; total: number }> {
    try {
      const cutoff = Date.now() - retentionMs;
      const rows = this.tx.queryMany(mtrxQueryTenantUsage({ cutoff, limit })) as unknown as Array<{ tenant_id: string; resource: string; total: number }>;
      return rows;
    } catch { return []; }
  }
}
