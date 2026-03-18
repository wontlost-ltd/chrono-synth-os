/**
 * 可观测性 Outbox SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  ObsOutboxRow, ObsRollupRow,
  ObsPublishEventParams, ObsRequeueStaleParams,
  ObsMarkProcessingParams, ObsMarkSentParams, ObsMarkFailedParams,
  ObsApplyRollupDeltaParams,
} from '@chrono/kernel';
import {
  OBS_QUERY_PENDING_EVENTS, OBS_QUERY_BACKLOG_PENDING,
  OBS_QUERY_BACKLOG_PROCESSING, OBS_QUERY_BACKLOG_FAILED, OBS_QUERY_ROLLUP,
  OBS_CMD_PUBLISH_EVENT, OBS_CMD_REQUEUE_STALE,
  OBS_CMD_MARK_PROCESSING, OBS_CMD_MARK_SENT, OBS_CMD_MARK_FAILED,
  OBS_CMD_APPLY_ROLLUP_DELTA,
} from '@chrono/kernel';

export function registerObservabilityOutboxExecutors(): void {
  /* ── Queries ── */

  registerQuery<readonly ObsOutboxRow[], number>(OBS_QUERY_PENDING_EVENTS, (db, limit) => {
    return db.prepare<ObsOutboxRow>(
      `SELECT * FROM observability_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(limit);
  });

  registerQuery<{ count: number } | null, void>(OBS_QUERY_BACKLOG_PENDING, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'pending'`,
    ).get() ?? null;
  });

  registerQuery<{ count: number } | null, void>(OBS_QUERY_BACKLOG_PROCESSING, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'processing'`,
    ).get() ?? null;
  });

  registerQuery<{ count: number } | null, void>(OBS_QUERY_BACKLOG_FAILED, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'failed'`,
    ).get() ?? null;
  });

  registerQuery<ObsRollupRow | null, string>(OBS_QUERY_ROLLUP, (db, tenantId) => {
    return db.prepare<ObsRollupRow>(
      'SELECT * FROM observability_rollups WHERE tenant_id = ? LIMIT 1',
    ).get(tenantId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<ObsPublishEventParams>(OBS_CMD_PUBLISH_EVENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO observability_outbox (
        id, tenant_id, topic, event_type, partition_key, payload_json,
        status, attempts, created_at, processed_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)`,
    ).run(p.id, p.tenantId, p.topic, p.eventType, p.partitionKey, p.payloadJson, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsRequeueStaleParams>(OBS_CMD_REQUEUE_STALE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET status = 'pending', processed_at = NULL
       WHERE status = 'processing' AND processed_at IS NOT NULL AND processed_at < ?`,
    ).run(p.staleBefore);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsMarkProcessingParams>(OBS_CMD_MARK_PROCESSING, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET status = 'processing', processed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsMarkSentParams>(OBS_CMD_MARK_SENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET status = 'sent', processed_at = ?, last_error = NULL
       WHERE id = ?`,
    ).run(p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsMarkFailedParams>(OBS_CMD_MARK_FAILED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET attempts = ?, last_error = ?, processed_at = ?, status = ?
       WHERE id = ?`,
    ).run(p.attempts, p.error, p.now, p.status, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsApplyRollupDeltaParams>(OBS_CMD_APPLY_ROLLUP_DELTA, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO observability_rollups (
        tenant_id,
        runtime_completed_count, runtime_duration_total_ms,
        task_terminal_count, task_success_count, task_rejected_count, task_disputed_count,
        wallet_settlement_count, wallet_settlement_total_amount_minor, wallet_settlement_latency_total_ms,
        governance_case_opened_count, governance_case_active_count, governance_action_applied_count,
        persona_growth_total, persona_growth_event_count, persona_reputation_delta_total,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        runtime_completed_count = observability_rollups.runtime_completed_count + excluded.runtime_completed_count,
        runtime_duration_total_ms = observability_rollups.runtime_duration_total_ms + excluded.runtime_duration_total_ms,
        task_terminal_count = observability_rollups.task_terminal_count + excluded.task_terminal_count,
        task_success_count = observability_rollups.task_success_count + excluded.task_success_count,
        task_rejected_count = observability_rollups.task_rejected_count + excluded.task_rejected_count,
        task_disputed_count = observability_rollups.task_disputed_count + excluded.task_disputed_count,
        wallet_settlement_count = observability_rollups.wallet_settlement_count + excluded.wallet_settlement_count,
        wallet_settlement_total_amount_minor = observability_rollups.wallet_settlement_total_amount_minor + excluded.wallet_settlement_total_amount_minor,
        wallet_settlement_latency_total_ms = observability_rollups.wallet_settlement_latency_total_ms + excluded.wallet_settlement_latency_total_ms,
        governance_case_opened_count = observability_rollups.governance_case_opened_count + excluded.governance_case_opened_count,
        governance_case_active_count = CASE
          WHEN observability_rollups.governance_case_active_count + excluded.governance_case_active_count < 0 THEN 0
          ELSE observability_rollups.governance_case_active_count + excluded.governance_case_active_count
        END,
        governance_action_applied_count = observability_rollups.governance_action_applied_count + excluded.governance_action_applied_count,
        persona_growth_total = observability_rollups.persona_growth_total + excluded.persona_growth_total,
        persona_growth_event_count = observability_rollups.persona_growth_event_count + excluded.persona_growth_event_count,
        persona_reputation_delta_total = observability_rollups.persona_reputation_delta_total + excluded.persona_reputation_delta_total,
        updated_at = excluded.updated_at`,
    ).run(
      p.tenantId,
      p.runtimeCompletedCount, p.runtimeDurationTotalMs,
      p.taskTerminalCount, p.taskSuccessCount, p.taskRejectedCount, p.taskDisputedCount,
      p.walletSettlementCount, p.walletSettlementTotalAmountMinor, p.walletSettlementLatencyTotalMs,
      p.governanceCaseOpenedCount, p.governanceCaseActiveCount, p.governanceActionAppliedCount,
      p.personaGrowthTotal, p.personaGrowthEventCount, p.personaReputationDeltaTotal,
      p.updatedAt,
    );
    return { rowsAffected: result.changes };
  });
}
