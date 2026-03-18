/**
 * Platform DLQ Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const DLQ_QUERY_BY_TENANT = 'dlq.by-tenant' as const;
export const DLQ_QUERY_BACKLOG_PENDING = 'dlq.backlog-pending' as const;
export const DLQ_QUERY_BACKLOG_REPLAYED = 'dlq.backlog-replayed' as const;
export const DLQ_QUERY_BY_ID = 'dlq.by-id' as const;

/* ── Command Kinds ── */

export const DLQ_CMD_RECORD = 'dlq.record' as const;
export const DLQ_CMD_MARK_REPLAYED = 'dlq.mark-replayed' as const;

/* ── 行类型 ── */

export interface DlqEventRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_component: string;
  readonly source_topic: string;
  readonly dlq_topic: string;
  readonly event_type: string;
  readonly partition_key: string | null;
  readonly payload_json: string;
  readonly error_message: string;
  readonly status: string;
  readonly created_at: number;
  readonly replayed_at: number | null;
}

/* ── 参数类型 ── */

export interface DlqRecordParams {
  id: string;
  tenantId: string;
  sourceComponent: string;
  sourceTopic: string;
  dlqTopic: string;
  eventType: string;
  partitionKey: string | null;
  payloadJson: string;
  errorMessage: string;
  createdAt: number;
}

export interface DlqByTenantParams {
  tenantId: string;
  limit: number;
}

export interface DlqMarkReplayedParams {
  id: string;
  now: number;
}

/* ── Query 工厂 ── */

export function dlqQueryByTenant(tenantId: string, limit: number): Query<DlqEventRow, DlqByTenantParams> {
  return { kind: DLQ_QUERY_BY_TENANT, params: { tenantId, limit } };
}

export function dlqQueryBacklogPending(): Query<{ count: number } | null, void> {
  return { kind: DLQ_QUERY_BACKLOG_PENDING, params: undefined as unknown as void };
}

export function dlqQueryBacklogReplayed(): Query<{ count: number } | null, void> {
  return { kind: DLQ_QUERY_BACKLOG_REPLAYED, params: undefined as unknown as void };
}

export function dlqQueryById(id: string): Query<DlqEventRow | null, string> {
  return { kind: DLQ_QUERY_BY_ID, params: id };
}

/* ── Command 工厂 ── */

export function dlqCmdRecord(params: DlqRecordParams): Command<DlqRecordParams> {
  return { kind: DLQ_CMD_RECORD, params };
}

export function dlqCmdMarkReplayed(params: DlqMarkReplayedParams): Command<DlqMarkReplayedParams> {
  return { kind: DLQ_CMD_MARK_REPLAYED, params };
}
