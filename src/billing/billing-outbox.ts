/**
 * Stripe 计量发件箱
 * 将计量事件持久化到本地表，异步重试确保不丢失
 */

import type { AppConfig } from '../config/schema.js';
import type { SyncWriteUnitOfWork, BillingOutboxRow } from '@chrono/kernel';
import {
  boutboxQueryPending, boutboxQueryPendingCount, boutboxQueryFailedCount,
  boutboxCmdEnqueue, boutboxCmdRequeueStale, boutboxCmdClaim,
  boutboxCmdMarkSent, boutboxCmdMarkFailed,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { reportUsage } from './stripe-client.js';

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export class BillingOutbox {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly config: AppConfig,
  ) {
    registerCoreSelfExecutors();
  }

  /** 入队一条计量事件 */
  enqueue(tenantId: string, customerId: string, eventName: string, quantity: number): void {
    const idempotencyKey = `${tenantId}:${eventName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.tx.execute(boutboxCmdEnqueue({
      tenantId, customerId, eventName, quantity, idempotencyKey, now: Date.now(),
    }));
  }

  /** 处理待发送的计量事件（批量，适合定时调用） */
  async flush(batchSize = 50): Promise<{ processed: number; failed: number }> {
    /* 回收卡在 processing 超过阈值的行（崩溃恢复） */
    this.tx.execute(boutboxCmdRequeueStale(Date.now() - STALE_PROCESSING_MS));

    const rows = [...this.tx.queryMany(boutboxQueryPending(MAX_ATTEMPTS, batchSize))] as unknown as BillingOutboxRow[];

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      /* 乐观锁：标记为 processing 并记录认领时间 */
      const result = this.tx.execute(boutboxCmdClaim(row.id, Date.now()));
      if (result.rowsAffected === 0) continue;

      try {
        await reportUsage(this.config, row.customer_id, row.event_name, row.quantity, row.idempotency_key);
        this.tx.execute(boutboxCmdMarkSent(row.id, Date.now()));
        processed++;
        billingMetrics.meterEventsProcessed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.tx.execute(boutboxCmdMarkFailed(row.id, errMsg, MAX_ATTEMPTS));
        failed++;
        if (row.attempts + 1 >= MAX_ATTEMPTS) {
          billingMetrics.meterEventsFailed++;
        }
      }
    }

    return { processed, failed };
  }

  /** 获取待处理数量 */
  pendingCount(): number {
    return Number(this.tx.queryOne(boutboxQueryPendingCount())?.count ?? 0);
  }

  /** 获取失败数量 */
  failedCount(): number {
    return Number(this.tx.queryOne(boutboxQueryFailedCount())?.count ?? 0);
  }
}

/** 全局计量指标计数器 */
export const billingMetrics = {
  meterEventsEnqueued: 0,
  meterEventsProcessed: 0,
  meterEventsFailed: 0,
};
