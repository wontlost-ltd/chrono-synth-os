/**
 * 计费发件箱 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const BOUTBOX_QUERY_PENDING = 'billingOutbox.pending' as const;
export const BOUTBOX_QUERY_PENDING_COUNT = 'billingOutbox.pendingCount' as const;
export const BOUTBOX_QUERY_FAILED_COUNT = 'billingOutbox.failedCount' as const;

/* ── Command Kinds ── */

export const BOUTBOX_CMD_ENQUEUE = 'billingOutbox.enqueue' as const;
export const BOUTBOX_CMD_REQUEUE_STALE = 'billingOutbox.requeueStale' as const;
export const BOUTBOX_CMD_CLAIM = 'billingOutbox.claim' as const;
export const BOUTBOX_CMD_MARK_SENT = 'billingOutbox.markSent' as const;
export const BOUTBOX_CMD_MARK_FAILED = 'billingOutbox.markFailed' as const;

/* ── 行类型 ── */

export interface BillingOutboxRow {
  id: number;
  tenant_id: string;
  customer_id: string;
  event_name: string;
  quantity: number;
  idempotency_key: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  processed_at: number | null;
}

/* ── 参数类型 ── */

export interface BoutboxEnqueueParams {
  tenantId: string;
  customerId: string;
  eventName: string;
  quantity: number;
  idempotencyKey: string;
  now: number;
}

export interface BoutboxPendingParams {
  maxAttempts: number;
  limit: number;
}

export interface BoutboxRequeueStaleParams {
  staleThreshold: number;
}

export interface BoutboxClaimParams {
  id: number;
  now: number;
}

export interface BoutboxMarkSentParams {
  id: number;
  now: number;
}

export interface BoutboxMarkFailedParams {
  id: number;
  errorMessage: string;
  maxAttempts: number;
}

/* ── Query 工厂 ── */

export function boutboxQueryPending(maxAttempts: number, limit: number): Query<BillingOutboxRow, BoutboxPendingParams> {
  return { kind: BOUTBOX_QUERY_PENDING, params: { maxAttempts, limit } };
}

export function boutboxQueryPendingCount(): Query<{ count: number } | null, void> {
  return { kind: BOUTBOX_QUERY_PENDING_COUNT, params: undefined as unknown as void };
}

export function boutboxQueryFailedCount(): Query<{ count: number } | null, void> {
  return { kind: BOUTBOX_QUERY_FAILED_COUNT, params: undefined as unknown as void };
}

/* ── Command 工厂 ── */

export function boutboxCmdEnqueue(params: BoutboxEnqueueParams): Command<BoutboxEnqueueParams> {
  return { kind: BOUTBOX_CMD_ENQUEUE, params };
}

export function boutboxCmdRequeueStale(staleThreshold: number): Command<BoutboxRequeueStaleParams> {
  return { kind: BOUTBOX_CMD_REQUEUE_STALE, params: { staleThreshold } };
}

export function boutboxCmdClaim(id: number, now: number): Command<BoutboxClaimParams> {
  return { kind: BOUTBOX_CMD_CLAIM, params: { id, now } };
}

export function boutboxCmdMarkSent(id: number, now: number): Command<BoutboxMarkSentParams> {
  return { kind: BOUTBOX_CMD_MARK_SENT, params: { id, now } };
}

export function boutboxCmdMarkFailed(id: number, errorMessage: string, maxAttempts: number): Command<BoutboxMarkFailedParams> {
  return { kind: BOUTBOX_CMD_MARK_FAILED, params: { id, errorMessage, maxAttempts } };
}
