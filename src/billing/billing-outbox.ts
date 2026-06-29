/**
 * Stripe 计量发件箱
 * 将计量事件持久化到本地表，异步重试确保不丢失
 */

import type { AppConfig } from '../config/schema.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  boutboxQueryPending, boutboxQueryPendingCount, boutboxQueryFailedCount,
  boutboxCmdEnqueue, boutboxCmdRequeueStale, boutboxCmdClaim,
  boutboxCmdMarkSent, boutboxCmdMarkFailed,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { reportUsage } from './stripe-client.js';
import { realClock, type Clock } from '../utils/clock.js';

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

/*
 * 进程级单调序号：无 sourceId 时用于派生 idempotency_key 后缀。**进程全局而非实例字段**——
 * BillingOutbox 在部分路由按注册期单例、ModelRouter 却按请求复用单例，无法假设实例生命周期；
 * 用模块级计数器保证同进程内同毫秒多次入队也永不撞 key（实例级字段会在 per-request 实例化时
 * 重置为 0 导致碰撞，这是审查发现的隐患——上移到进程级根除）。非随机，仍守确定性铁律。
 */
let fallbackSeqCounter = 0;

export class BillingOutbox {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly config: AppConfig,
    /*
     * 时钟抽象（确定性）：入队/认领/标记时间戳须可注入以便测试复现。默认 realClock。
     */
    private readonly clock: Clock = realClock,
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 入队一条计量事件。返回 `true`=新落库，`false`=撞幂等键被去重（调用方据此精确计量，避免
   * 把重复事件计入 meterEventsEnqueued）。
   *
   * 防重复计费（幂等性）：当调用方提供 `sourceId`（计量事件的业务因果锚点，如 message id /
   * simulation id）时，idempotency_key 由 `tenant:event:sourceId` 确定性派生——同一逻辑事件
   * 重复入队会撞 UNIQUE 约束被去重（executor 用 ON CONFLICT DO NOTHING），Stripe 只计一次。
   * 未提供 sourceId 时退化为「tenant:event:clock:进程序号」——**不含 Math.random()**，进程级序号
   * 保证同进程内唯一（不随实例生命周期重置），仍守确定性铁律；但无 sourceId 时不具备跨进程/
   * 跨重试去重能力（与原随机键行为相当，不更差）。
   */
  enqueue(tenantId: string, customerId: string, eventName: string, quantity: number, sourceId?: string): boolean {
    const idempotencyKey = sourceId !== undefined && sourceId.length > 0
      ? `${tenantId}:${eventName}:${sourceId}`
      : `${tenantId}:${eventName}:${this.clock.now()}:${fallbackSeqCounter++}`;
    const result = this.tx.execute(boutboxCmdEnqueue({
      tenantId, customerId, eventName, quantity, idempotencyKey, now: this.clock.now(),
    }));
    /* rowsAffected=0 → ON CONFLICT DO NOTHING 命中，重复事件被去重 */
    return result.rowsAffected > 0;
  }

  /** 处理待发送的计量事件（批量，适合定时调用） */
  async flush(batchSize = 50): Promise<{ processed: number; failed: number }> {
    /* 回收卡在 processing 超过阈值的行（崩溃恢复） */
    this.tx.execute(boutboxCmdRequeueStale(this.clock.now() - STALE_PROCESSING_MS));

    const rows = [...this.tx.queryMany(boutboxQueryPending(MAX_ATTEMPTS, batchSize))];

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      /* 乐观锁：标记为 processing 并记录认领时间 */
      const result = this.tx.execute(boutboxCmdClaim(row.id, this.clock.now()));
      if (result.rowsAffected === 0) continue;

      try {
        await reportUsage(this.config, row.customer_id, row.event_name, row.quantity, row.idempotency_key);
        this.tx.execute(boutboxCmdMarkSent(row.id, this.clock.now()));
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
