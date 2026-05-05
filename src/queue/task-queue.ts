/**
 * 数据库驱动的任务队列
 * 通过 SyncWriteUnitOfWork 的 Query/Command 契约访问数据，
 * 不直接调用 db.prepare()
 */

import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { TaskRow } from '@chrono/kernel';
import {
  taskQueryById, taskQueryDequeueCandidate, taskQueryExpiredIds,
  taskCmdEnqueue, taskCmdClaim, taskCmdComplete, taskCmdFail,
  taskCmdReschedule, taskCmdDeleteBatch, taskCmdReapRetryable, taskCmdReapExhausted,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { QuotaExceededError } from '../errors/index.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: string;
  readonly status: TaskStatus;
  readonly result: string | null;
  readonly error: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly availableAt: number;
  readonly claimedBy: string | null;
  readonly claimedAt: number | null;
}

function rowToRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    payload: row.payload,
    status: row.status as TaskStatus,
    result: row.result,
    error: row.error,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availableAt: row.available_at,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
  };
}

export interface TaskQueueConfig {
  /** 每租户最大待处理任务数（超出时 enqueue 抛异常），0=无限制 */
  readonly maxPendingPerTenant: number;
  /** 已完成/失败任务保留时长（毫秒），超过后由 purgeCompleted 清理 */
  readonly completedRetentionMs: number;
}

const DEFAULT_QUEUE_CONFIG: TaskQueueConfig = {
  maxPendingPerTenant: 1000,
  completedRetentionMs: 7 * 24 * 60 * 60 * 1000,
};

export class TaskQueue {
  private readonly workerId: string;
  private readonly config: TaskQueueConfig;
  private readonly db: IDatabase;
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase, workerId?: string, config?: Partial<TaskQueueConfig>) {
    this.db = db;
    this.workerId = workerId ?? generatePrefixedId('worker');
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
    registerCoreSelfExecutors();
    this.tx = db;
  }

  /** 入队新任务（priority: 0=普通, 1=高优先, 2=紧急） */
  enqueue(tenantId: string, type: string, payload: unknown, maxRetries = 3, priority = 0): string {
    const id = generatePrefixedId('task');
    const now = Date.now();

    const result = this.tx.execute(taskCmdEnqueue({
      id, tenantId, type, payload: JSON.stringify(payload),
      maxRetries, now, priority, maxPending: this.config.maxPendingPerTenant,
    }));

    if (result.rowsAffected === 0) {
      throw new QuotaExceededError(`租户 ${tenantId} 待处理任务已达上限 (${this.config.maxPendingPerTenant})`);
    }
    return id;
  }

  /** 原子出队：优先级降序 + 时间升序，同一租户连续运行任务数受限（公平调度） */
  dequeue(now?: number): TaskRecord | undefined {
    const ts = now ?? Date.now();
    return this.db.transaction(() => {
      const row = this.tx.queryOne(taskQueryDequeueCandidate(ts));
      if (!row) return undefined;

      const claimed = this.tx.execute(taskCmdClaim({ taskId: row.id, workerId: this.workerId, now: ts }));
      if (claimed.rowsAffected === 0) return undefined;

      return rowToRecord({ ...row, status: 'running', claimed_by: this.workerId, claimed_at: ts, updated_at: ts });
    });
  }

  /** 标记任务完成 */
  complete(taskId: string, result: unknown): void {
    this.tx.execute(taskCmdComplete({ taskId, result: JSON.stringify(result), now: Date.now() }));
  }

  /** 标记任务失败 */
  fail(taskId: string, error: string): void {
    this.tx.execute(taskCmdFail({ taskId, error, now: Date.now() }));
  }

  /** 重新调度任务（指数退避） */
  reschedule(taskId: string, retryCount: number, availableAt: number, error: string): void {
    this.tx.execute(taskCmdReschedule({ taskId, retryCount, availableAt, error, now: Date.now() }));
  }

  /** 查询任务状态 */
  getTask(taskId: string): TaskRecord | undefined {
    const row = this.tx.queryOne(taskQueryById(taskId));
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * 清理已完成/失败的过期任务（批量删除，避免大表膨胀）
   * @returns 清理的任务数
   */
  purgeCompleted(batchSize = 1000): number {
    const cutoff = Date.now() - this.config.completedRetentionMs;
    let total = 0;
    while (true) {
      const ids = this.tx.queryMany(taskQueryExpiredIds(cutoff, batchSize));
      if (ids.length === 0) break;
      this.tx.execute(taskCmdDeleteBatch(ids.map(r => r.id)));
      total += ids.length;
      if (ids.length < batchSize) break;
    }
    return total;
  }

  /**
   * 回收卡死任务：将超时的 running 任务重置为 pending
   * @param staleThresholdMs 判定卡死的阈值（默认 5 分钟）
   * @returns 回收的任务数
   */
  reapStaleTasks(staleThresholdMs = 300_000): number {
    const now = Date.now();
    const cutoff = now - staleThresholdMs;

    const requeued = this.tx.execute(taskCmdReapRetryable({ now, cutoff }));
    const failed = this.tx.execute(taskCmdReapExhausted({ now, cutoff, errorMessage: '任务超时且已达到最大重试次数' }));

    return requeued.rowsAffected + failed.rowsAffected;
  }
}
