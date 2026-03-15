import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export const OBSERVABILITY_TOPIC = 'observability.events';

export type ObservabilityTopic = typeof OBSERVABILITY_TOPIC;
export type ObservabilityEventType =
  | 'runtime.completed'
  | 'task.outcome'
  | 'wallet.settlement_completed'
  | 'governance.case_opened'
  | 'governance.action_applied'
  | 'persona.growth_recorded';

export type ObservabilityOutboxStatus = 'pending' | 'processing' | 'sent' | 'failed';

export interface ObservabilityEventEnvelope {
  tenantId: string;
  topic: ObservabilityTopic;
  eventType: ObservabilityEventType;
  partitionKey: string;
  payload: Record<string, unknown>;
}

export interface ObservabilityOutboxRow {
  id: string;
  tenant_id: string;
  topic: string;
  event_type: ObservabilityEventType;
  partition_key: string;
  payload_json: string;
  status: ObservabilityOutboxStatus;
  attempts: number;
  created_at: number;
  processed_at: number | null;
  last_error: string | null;
}

export interface ObservabilityOutboxBacklog {
  pending: number;
  processing: number;
  failed: number;
}

export interface ObservabilityRollupRow {
  tenant_id: string;
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

export interface ObservabilityRollupDelta {
  runtimeCompletedCount?: number;
  runtimeDurationTotalMs?: number;
  taskTerminalCount?: number;
  taskSuccessCount?: number;
  taskRejectedCount?: number;
  taskDisputedCount?: number;
  walletSettlementCount?: number;
  walletSettlementTotalAmountMinor?: number;
  walletSettlementLatencyTotalMs?: number;
  governanceCaseOpenedCount?: number;
  governanceCaseActiveCount?: number;
  governanceActionAppliedCount?: number;
  personaGrowthTotal?: number;
  personaGrowthEventCount?: number;
  personaReputationDeltaTotal?: number;
  updatedAt?: number;
}

export const observabilityPipelineMetrics = {
  eventsEnqueued: 0,
  eventsProcessed: 0,
  eventsFailed: 0,
  eventsRecovered: 0,
};

export function resetObservabilityPipelineMetrics(): void {
  observabilityPipelineMetrics.eventsEnqueued = 0;
  observabilityPipelineMetrics.eventsProcessed = 0;
  observabilityPipelineMetrics.eventsFailed = 0;
  observabilityPipelineMetrics.eventsRecovered = 0;
}

export function publishObservabilityEvent(db: IDatabase, event: ObservabilityEventEnvelope): string {
  const id = generatePrefixedId('obevt');
  db.prepare<void>(
    `INSERT INTO observability_outbox (
      id, tenant_id, topic, event_type, partition_key, payload_json,
      status, attempts, created_at, processed_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(
    id,
    event.tenantId,
    event.topic,
    event.eventType,
    event.partitionKey,
    JSON.stringify(event.payload),
    Date.now(),
  );
  observabilityPipelineMetrics.eventsEnqueued++;
  return id;
}

export function listPendingObservabilityEvents(db: IDatabase, limit: number): ObservabilityOutboxRow[] {
  return db.prepare<ObservabilityOutboxRow>(
    `SELECT * FROM observability_outbox
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(limit);
}

export function requeueStaleObservabilityEvents(db: IDatabase, staleBefore: number): number {
  const result = db.prepare<void>(
    `UPDATE observability_outbox
     SET status = 'pending', processed_at = NULL
     WHERE status = 'processing' AND processed_at IS NOT NULL AND processed_at < ?`,
  ).run(staleBefore);
  const count = result.changes;
  if (count > 0) {
    observabilityPipelineMetrics.eventsRecovered += count;
  }
  return count;
}

export function markObservabilityEventProcessing(db: IDatabase, id: string): boolean {
  const result = db.prepare<void>(
    `UPDATE observability_outbox
     SET status = 'processing', processed_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(Date.now(), id);
  return result.changes > 0;
}

export function markObservabilityEventSent(db: IDatabase, id: string): void {
  db.prepare<void>(
    `UPDATE observability_outbox
     SET status = 'sent', processed_at = ?, last_error = NULL
     WHERE id = ?`,
  ).run(Date.now(), id);
  observabilityPipelineMetrics.eventsProcessed++;
}

export function markObservabilityEventFailed(
  db: IDatabase,
  row: ObservabilityOutboxRow,
  error: string,
  maxAttempts: number,
): void {
  const nextAttempts = row.attempts + 1;
  db.prepare<void>(
    `UPDATE observability_outbox
     SET attempts = ?, last_error = ?, processed_at = ?, status = ?
     WHERE id = ?`,
  ).run(
    nextAttempts,
    error,
    Date.now(),
    nextAttempts >= maxAttempts ? 'failed' : 'pending',
    row.id,
  );
  observabilityPipelineMetrics.eventsFailed++;
}

export function getObservabilityOutboxBacklog(db: IDatabase): ObservabilityOutboxBacklog {
  const pending = db.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'pending'`,
  ).get()?.count ?? 0;
  const processing = db.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'processing'`,
  ).get()?.count ?? 0;
  const failed = db.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'failed'`,
  ).get()?.count ?? 0;
  return { pending, processing, failed };
}

export function getObservabilityRollup(db: IDatabase, tenantId: string): ObservabilityRollupRow {
  const row = db.prepare<ObservabilityRollupRow>(
    'SELECT * FROM observability_rollups WHERE tenant_id = ? LIMIT 1',
  ).get(tenantId);
  return row ?? emptyObservabilityRollup(tenantId);
}

export function applyObservabilityRollupDelta(
  db: IDatabase,
  tenantId: string,
  delta: ObservabilityRollupDelta,
): void {
  const updatedAt = delta.updatedAt ?? Date.now();
  const runtimeCompletedCount = delta.runtimeCompletedCount ?? 0;
  const runtimeDurationTotalMs = delta.runtimeDurationTotalMs ?? 0;
  const taskTerminalCount = delta.taskTerminalCount ?? 0;
  const taskSuccessCount = delta.taskSuccessCount ?? 0;
  const taskRejectedCount = delta.taskRejectedCount ?? 0;
  const taskDisputedCount = delta.taskDisputedCount ?? 0;
  const walletSettlementCount = delta.walletSettlementCount ?? 0;
  const walletSettlementTotalAmountMinor = delta.walletSettlementTotalAmountMinor ?? 0;
  const walletSettlementLatencyTotalMs = delta.walletSettlementLatencyTotalMs ?? 0;
  const governanceCaseOpenedCount = delta.governanceCaseOpenedCount ?? 0;
  const governanceCaseActiveCount = delta.governanceCaseActiveCount ?? 0;
  const governanceActionAppliedCount = delta.governanceActionAppliedCount ?? 0;
  const personaGrowthTotal = delta.personaGrowthTotal ?? 0;
  const personaGrowthEventCount = delta.personaGrowthEventCount ?? 0;
  const personaReputationDeltaTotal = delta.personaReputationDeltaTotal ?? 0;

  db.prepare<void>(
    `INSERT INTO observability_rollups (
      tenant_id,
      runtime_completed_count,
      runtime_duration_total_ms,
      task_terminal_count,
      task_success_count,
      task_rejected_count,
      task_disputed_count,
      wallet_settlement_count,
      wallet_settlement_total_amount_minor,
      wallet_settlement_latency_total_ms,
      governance_case_opened_count,
      governance_case_active_count,
      governance_action_applied_count,
      persona_growth_total,
      persona_growth_event_count,
      persona_reputation_delta_total,
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
    tenantId,
    runtimeCompletedCount,
    runtimeDurationTotalMs,
    taskTerminalCount,
    taskSuccessCount,
    taskRejectedCount,
    taskDisputedCount,
    walletSettlementCount,
    walletSettlementTotalAmountMinor,
    walletSettlementLatencyTotalMs,
    governanceCaseOpenedCount,
    governanceCaseActiveCount,
    governanceActionAppliedCount,
    personaGrowthTotal,
    personaGrowthEventCount,
    personaReputationDeltaTotal,
    updatedAt,
  );
}

function emptyObservabilityRollup(tenantId: string): ObservabilityRollupRow {
  return {
    tenant_id: tenantId,
    runtime_completed_count: 0,
    runtime_duration_total_ms: 0,
    task_terminal_count: 0,
    task_success_count: 0,
    task_rejected_count: 0,
    task_disputed_count: 0,
    wallet_settlement_count: 0,
    wallet_settlement_total_amount_minor: 0,
    wallet_settlement_latency_total_ms: 0,
    governance_case_opened_count: 0,
    governance_case_active_count: 0,
    governance_action_applied_count: 0,
    persona_growth_total: 0,
    persona_growth_event_count: 0,
    persona_reputation_delta_total: 0,
    updated_at: 0,
  };
}
