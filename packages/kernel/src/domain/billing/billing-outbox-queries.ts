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
  /**
   * 认领超时**时长**（毫秒），不是绝对截止时刻（issue #393，与 observability outbox #380 同型）。
   *
   * ⚠️ 截止点必须由**数据库**算，不能由调用方时钟算：`billing_outbox` 的 flush 定时器跑在
   * **API 进程内**（`app.ts` 的 60s setInterval），而 `k8s/deployment.yml` 是 `replicas: 2`
   * —— 两个副本各自认领/回收同一张表。各用本机 `Date.now()` 时，钟差会平移 stale 判定：
   * 实测钟差 > STALE_PROCESSING_MS（5min）时，**正在处理中的行被回收 → 重发 Stripe**。
   *
   * ⚠️ 字段名从 `staleThreshold` 改成 `staleProcessingMs` 是**刻意的**：语义从「绝对时刻」
   * 翻转成「时长」而类型仍是 `number`，TS 拦不住同名回退（#381 实测：回退某个调用点后
   * 全套测试仍全绿）。改名让漏改的调用点在**编译期**就暴露。
   */
  staleProcessingMs: number;
}

export interface BoutboxClaimParams {
  id: number;
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

export function boutboxCmdRequeueStale(staleProcessingMs: number): Command<BoutboxRequeueStaleParams> {
  return { kind: BOUTBOX_CMD_REQUEUE_STALE, params: { staleProcessingMs } };
}

export function boutboxCmdClaim(id: number): Command<BoutboxClaimParams> {
  return { kind: BOUTBOX_CMD_CLAIM, params: { id } };
}

export function boutboxCmdMarkSent(id: number, now: number): Command<BoutboxMarkSentParams> {
  return { kind: BOUTBOX_CMD_MARK_SENT, params: { id, now } };
}

export function boutboxCmdMarkFailed(id: number, errorMessage: string, maxAttempts: number): Command<BoutboxMarkFailedParams> {
  return { kind: BOUTBOX_CMD_MARK_FAILED, params: { id, errorMessage, maxAttempts } };
}
