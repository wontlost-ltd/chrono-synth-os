/**
 * 可观测性 Outbox Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const OBS_QUERY_PENDING_EVENTS = 'obs-outbox.pending-events' as const;
export const OBS_QUERY_BACKLOG_PENDING = 'obs-outbox.backlog-pending' as const;
export const OBS_QUERY_BACKLOG_PROCESSING = 'obs-outbox.backlog-processing' as const;
export const OBS_QUERY_BACKLOG_FAILED = 'obs-outbox.backlog-failed' as const;
export const OBS_QUERY_ROLLUP = 'obs-outbox.rollup' as const;

/* ── Command Kinds ── */

export const OBS_CMD_PUBLISH_EVENT = 'obs-outbox.publish-event' as const;
export const OBS_CMD_REQUEUE_STALE = 'obs-outbox.requeue-stale' as const;
export const OBS_CMD_MARK_PROCESSING = 'obs-outbox.mark-processing' as const;
export const OBS_CMD_MARK_SENT = 'obs-outbox.mark-sent' as const;
export const OBS_CMD_MARK_FAILED = 'obs-outbox.mark-failed' as const;
export const OBS_CMD_APPLY_ROLLUP_DELTA = 'obs-outbox.apply-rollup-delta' as const;

/* ── 行类型 ── */

export interface ObsOutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly topic: string;
  readonly event_type: string;
  readonly partition_key: string;
  readonly payload_json: string;
  readonly status: string;
  readonly attempts: number;
  readonly created_at: number;
  readonly processed_at: number | null;
  readonly last_error: string | null;
}

export interface ObsRollupRow {
  readonly tenant_id: string;
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

/* ── 参数类型 ── */

export interface ObsPublishEventParams {
  id: string;
  tenantId: string;
  topic: string;
  eventType: string;
  partitionKey: string;
  payloadJson: string;
  now: number;
}

export interface ObsRequeueStaleParams {
  staleBefore: number;
}

export interface ObsMarkProcessingParams {
  id: string;
  now: number;
}

export interface ObsMarkSentParams {
  id: string;
  now: number;
}

export interface ObsMarkFailedParams {
  id: string;
  attempts: number;
  error: string;
  now: number;
  status: string;
}

export interface ObsApplyRollupDeltaParams {
  tenantId: string;
  runtimeCompletedCount: number;
  runtimeDurationTotalMs: number;
  taskTerminalCount: number;
  taskSuccessCount: number;
  taskRejectedCount: number;
  taskDisputedCount: number;
  walletSettlementCount: number;
  walletSettlementTotalAmountMinor: number;
  walletSettlementLatencyTotalMs: number;
  governanceCaseOpenedCount: number;
  governanceCaseActiveCount: number;
  governanceActionAppliedCount: number;
  personaGrowthTotal: number;
  personaGrowthEventCount: number;
  personaReputationDeltaTotal: number;
  updatedAt: number;
}

/* ── Query 工厂 ── */

export function obsQueryPendingEvents(limit: number): Query<ObsOutboxRow, number> {
  return { kind: OBS_QUERY_PENDING_EVENTS, params: limit };
}

export function obsQueryBacklogPending(): Query<{ count: number } | null, void> {
  return { kind: OBS_QUERY_BACKLOG_PENDING, params: undefined as unknown as void };
}

export function obsQueryBacklogProcessing(): Query<{ count: number } | null, void> {
  return { kind: OBS_QUERY_BACKLOG_PROCESSING, params: undefined as unknown as void };
}

export function obsQueryBacklogFailed(): Query<{ count: number } | null, void> {
  return { kind: OBS_QUERY_BACKLOG_FAILED, params: undefined as unknown as void };
}

export function obsQueryRollup(tenantId: string): Query<ObsRollupRow | null, string> {
  return { kind: OBS_QUERY_ROLLUP, params: tenantId };
}

/* ── Command 工厂 ── */

export function obsCmdPublishEvent(params: ObsPublishEventParams): Command<ObsPublishEventParams> {
  return { kind: OBS_CMD_PUBLISH_EVENT, params };
}

export function obsCmdRequeueStale(params: ObsRequeueStaleParams): Command<ObsRequeueStaleParams> {
  return { kind: OBS_CMD_REQUEUE_STALE, params };
}

export function obsCmdMarkProcessing(params: ObsMarkProcessingParams): Command<ObsMarkProcessingParams> {
  return { kind: OBS_CMD_MARK_PROCESSING, params };
}

export function obsCmdMarkSent(params: ObsMarkSentParams): Command<ObsMarkSentParams> {
  return { kind: OBS_CMD_MARK_SENT, params };
}

export function obsCmdMarkFailed(params: ObsMarkFailedParams): Command<ObsMarkFailedParams> {
  return { kind: OBS_CMD_MARK_FAILED, params };
}

export function obsCmdApplyRollupDelta(params: ObsApplyRollupDeltaParams): Command<ObsApplyRollupDeltaParams> {
  return { kind: OBS_CMD_APPLY_ROLLUP_DELTA, params };
}
