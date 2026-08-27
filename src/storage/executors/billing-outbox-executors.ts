/**
 * 计费发件箱 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import { dbNowMs } from './db-now.js';
import type {
  BillingOutboxRow, BoutboxEnqueueParams, BoutboxPendingParams,
  BoutboxRequeueStaleParams, BoutboxClaimParams, BoutboxMarkSentParams,
  BoutboxMarkFailedParams,
} from '@chrono/kernel';
import {
  BOUTBOX_QUERY_PENDING, BOUTBOX_QUERY_PENDING_COUNT, BOUTBOX_QUERY_FAILED_COUNT,
  BOUTBOX_CMD_ENQUEUE, BOUTBOX_CMD_REQUEUE_STALE, BOUTBOX_CMD_CLAIM,
  BOUTBOX_CMD_MARK_SENT, BOUTBOX_CMD_MARK_FAILED,
} from '@chrono/kernel';

export function registerBillingOutboxExecutors(): void {
  /* ── Queries ── */

  registerQuery<readonly BillingOutboxRow[], BoutboxPendingParams>(BOUTBOX_QUERY_PENDING, (db, p) => {
    return db.prepare<BillingOutboxRow>(
      `SELECT * FROM billing_outbox WHERE status = 'pending' AND attempts < ? ORDER BY created_at ASC LIMIT ?`,
    ).all(p.maxAttempts, p.limit);
  });

  registerQuery<{ count: number } | null, void>(BOUTBOX_QUERY_PENDING_COUNT, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM billing_outbox WHERE status = 'pending'`,
    ).get() ?? null;
  });

  registerQuery<{ count: number } | null, void>(BOUTBOX_QUERY_FAILED_COUNT, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM billing_outbox WHERE status = 'failed'`,
    ).get() ?? null;
  });

  /* ── Commands ── */

  registerCommand<BoutboxEnqueueParams>(BOUTBOX_CMD_ENQUEUE, (db, p) => {
    /*
     * 幂等入队（防重复计费）：idempotency_key 现可由业务事件确定性派生（tenant:event:sourceId），
     * 同一逻辑计量事件重复入队会撞 UNIQUE(idempotency_key)。改用 ON CONFLICT DO NOTHING——
     * 重复事件被静默去重（Stripe 计量只记一次），而非抛 UNIQUE 错误中断调用方。
     */
    const result = db.prepare<void>(
      `INSERT INTO billing_outbox (tenant_id, customer_id, event_name, quantity, idempotency_key, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(p.tenantId, p.customerId, p.eventName, p.quantity, p.idempotencyKey, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<BoutboxRequeueStaleParams>(BOUTBOX_CMD_REQUEUE_STALE, (db, p) => {
    const result = db.prepare<void>(
      /* 截止点由**数据库**算（issue #393）：收的是时长，见 dbNowMs 的说明。 */
      `UPDATE billing_outbox SET status = 'pending', processed_at = NULL
       WHERE status = 'processing' AND processed_at IS NOT NULL
         AND processed_at < ${dbNowMs(db)} - ?`,
    ).run(p.staleProcessingMs);
    return { rowsAffected: result.changes };
  });

  registerCommand<BoutboxClaimParams>(BOUTBOX_CMD_CLAIM, (db, p) => {
    const result = db.prepare<void>(
      /* ⚠️ processed_at 由**数据库**盖戳，不接受应用传入（issue #393）。
       * flush 定时器跑在 API 进程内而 API replicas:2 —— 两副本各自认领/回收同一张表，
       * 各用本机 Date.now() 时钟差会平移 stale 判定（实测 >5min 钟差即误回收 → 重发 Stripe）。 */
      `UPDATE billing_outbox SET status = 'processing', processed_at = ${dbNowMs(db)}
       WHERE id = ? AND status = 'pending'`,
    ).run(p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<BoutboxMarkSentParams>(BOUTBOX_CMD_MARK_SENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE billing_outbox SET status = 'sent', processed_at = ? WHERE id = ?`,
    ).run(p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<BoutboxMarkFailedParams>(BOUTBOX_CMD_MARK_FAILED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE billing_outbox SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`,
    ).run(p.errorMessage, p.maxAttempts, p.id);
    return { rowsAffected: result.changes };
  });
}
