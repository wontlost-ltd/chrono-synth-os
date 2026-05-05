/**
 * 可观测性 Outbox — 事件发布、状态管理、Rollup 聚合
 * 通过 SyncWriteUnitOfWork 的 Query/Command 契约访问数据，
 * 不直接调用 db.prepare()
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  obsQueryPendingEvents, obsQueryBacklogPending, obsQueryBacklogProcessing,
  obsQueryBacklogFailed, obsQueryRollup,
  obsCmdPublishEvent, obsCmdRequeueStale, obsCmdMarkProcessing,
  obsCmdMarkSent, obsCmdMarkFailed, obsCmdApplyRollupDelta,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
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

export interface ObservabilityOutboxBacklog {
  pending: number;
  processing: number;
  failed: number;
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

export function publishObservabilityEvent(tx: SyncWriteUnitOfWork, event: ObservabilityEventEnvelope): string {
  registerCoreSelfExecutors();
  const id = generatePrefixedId('obevt');
  tx.execute(obsCmdPublishEvent({
    id,
    tenantId: event.tenantId,
    topic: event.topic,
    eventType: event.eventType,
    partitionKey: event.partitionKey,
    payloadJson: JSON.stringify(event.payload),
    now: Date.now(),
  }));
  observabilityPipelineMetrics.eventsEnqueued++;
  return id;
}

export function listPendingObservabilityEvents(tx: SyncWriteUnitOfWork, limit: number): ObservabilityOutboxRow[] {
  registerCoreSelfExecutors();
  return [...tx.queryMany(obsQueryPendingEvents(limit))] as ObservabilityOutboxRow[];
}

export function requeueStaleObservabilityEvents(tx: SyncWriteUnitOfWork, staleBefore: number): number {
  registerCoreSelfExecutors();
  const result = tx.execute(obsCmdRequeueStale({ staleBefore }));
  const count = result.rowsAffected;
  if (count > 0) {
    observabilityPipelineMetrics.eventsRecovered += count;
  }
  return count;
}

export function markObservabilityEventProcessing(tx: SyncWriteUnitOfWork, id: string): boolean {
  registerCoreSelfExecutors();
  const result = tx.execute(obsCmdMarkProcessing({ id, now: Date.now() }));
  return result.rowsAffected > 0;
}

export function markObservabilityEventSent(tx: SyncWriteUnitOfWork, id: string): void {
  registerCoreSelfExecutors();
  tx.execute(obsCmdMarkSent({ id, now: Date.now() }));
  observabilityPipelineMetrics.eventsProcessed++;
}

export function markObservabilityEventFailed(
  tx: SyncWriteUnitOfWork,
  row: ObservabilityOutboxRow,
  error: string,
  maxAttempts: number,
): void {
  registerCoreSelfExecutors();
  const nextAttempts = row.attempts + 1;
  tx.execute(obsCmdMarkFailed({
    id: row.id,
    attempts: nextAttempts,
    error,
    now: Date.now(),
    status: nextAttempts >= maxAttempts ? 'failed' : 'pending',
  }));
  observabilityPipelineMetrics.eventsFailed++;
}

export function getObservabilityOutboxBacklog(tx: SyncWriteUnitOfWork): ObservabilityOutboxBacklog {
  registerCoreSelfExecutors();
  const pending = tx.queryOne(obsQueryBacklogPending())?.count ?? 0;
  const processing = tx.queryOne(obsQueryBacklogProcessing())?.count ?? 0;
  const failed = tx.queryOne(obsQueryBacklogFailed())?.count ?? 0;
  return { pending, processing, failed };
}

export function getObservabilityRollup(tx: SyncWriteUnitOfWork, tenantId: string): ObservabilityRollupRow {
  registerCoreSelfExecutors();
  const row = tx.queryOne(obsQueryRollup(tenantId));
  return (row ?? emptyObservabilityRollup(tenantId)) as ObservabilityRollupRow;
}

export function applyObservabilityRollupDelta(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  delta: ObservabilityRollupDelta,
): void {
  registerCoreSelfExecutors();
  tx.execute(obsCmdApplyRollupDelta({
    tenantId,
    runtimeCompletedCount: delta.runtimeCompletedCount ?? 0,
    runtimeDurationTotalMs: delta.runtimeDurationTotalMs ?? 0,
    taskTerminalCount: delta.taskTerminalCount ?? 0,
    taskSuccessCount: delta.taskSuccessCount ?? 0,
    taskRejectedCount: delta.taskRejectedCount ?? 0,
    taskDisputedCount: delta.taskDisputedCount ?? 0,
    walletSettlementCount: delta.walletSettlementCount ?? 0,
    walletSettlementTotalAmountMinor: delta.walletSettlementTotalAmountMinor ?? 0,
    walletSettlementLatencyTotalMs: delta.walletSettlementLatencyTotalMs ?? 0,
    governanceCaseOpenedCount: delta.governanceCaseOpenedCount ?? 0,
    governanceCaseActiveCount: delta.governanceCaseActiveCount ?? 0,
    governanceActionAppliedCount: delta.governanceActionAppliedCount ?? 0,
    personaGrowthTotal: delta.personaGrowthTotal ?? 0,
    personaGrowthEventCount: delta.personaGrowthEventCount ?? 0,
    personaReputationDeltaTotal: delta.personaReputationDeltaTotal ?? 0,
    updatedAt: delta.updatedAt ?? Date.now(),
  }));
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
