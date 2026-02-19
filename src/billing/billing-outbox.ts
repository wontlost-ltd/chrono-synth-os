/**
 * Stripe 计量发件箱
 * 将计量事件持久化到本地表，异步重试确保不丢失
 */

import type { IDatabase } from '../storage/database.js';
import type { AppConfig } from '../config/schema.js';
import { reportUsage } from './stripe-client.js';

interface OutboxRow {
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

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export class BillingOutbox {
  constructor(
    private readonly db: IDatabase,
    private readonly config: AppConfig,
  ) {}

  /** 入队一条计量事件 */
  enqueue(tenantId: string, customerId: string, eventName: string, quantity: number): void {
    const idempotencyKey = `${tenantId}:${eventName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare<void>(
      `INSERT INTO billing_outbox (tenant_id, customer_id, event_name, quantity, idempotency_key, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(tenantId, customerId, eventName, quantity, idempotencyKey, Date.now());
  }

  /** 处理待发送的计量事件（批量，适合定时调用） */
  async flush(batchSize = 50): Promise<{ processed: number; failed: number }> {
    /* 回收卡在 processing 超过阈值的行（崩溃恢复，基于 processed_at 时间戳） */
    this.db.prepare<void>(
      `UPDATE billing_outbox SET status = 'pending', processed_at = NULL WHERE status = 'processing' AND processed_at < ?`,
    ).run(Date.now() - STALE_PROCESSING_MS);

    const rows = this.db.prepare<OutboxRow>(
      `SELECT * FROM billing_outbox WHERE status = 'pending' AND attempts < ? ORDER BY created_at ASC LIMIT ?`,
    ).all(MAX_ATTEMPTS, batchSize);

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      /* 乐观锁：标记为 processing 并记录认领时间，防止并发实例重复处理 */
      const claimed = this.db.prepare<void>(
        `UPDATE billing_outbox SET status = 'processing', processed_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(Date.now(), row.id);
      if ((claimed as unknown as { changes: number }).changes === 0) continue;

      try {
        await reportUsage(this.config, row.customer_id, row.event_name, row.quantity, row.idempotency_key);
        this.db.prepare<void>(
          `UPDATE billing_outbox SET status = 'sent', processed_at = ? WHERE id = ?`,
        ).run(Date.now(), row.id);
        processed++;
        billingMetrics.meterEventsProcessed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const nextAttempts = row.attempts + 1;
        this.db.prepare<void>(
          `UPDATE billing_outbox SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`,
        ).run(errMsg, MAX_ATTEMPTS, row.id);
        failed++;
        if (nextAttempts >= MAX_ATTEMPTS) {
          billingMetrics.meterEventsFailed++;
        }
      }
    }

    return { processed, failed };
  }

  /** 获取待处理数量 */
  pendingCount(): number {
    return this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'pending'`,
    ).get()?.count ?? 0;
  }

  /** 获取失败数量 */
  failedCount(): number {
    return this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'failed'`,
    ).get()?.count ?? 0;
  }
}

/** 全局计量指标计数器 */
export const billingMetrics = {
  meterEventsEnqueued: 0,
  meterEventsProcessed: 0,
  meterEventsFailed: 0,
};
