/**
 * 数据库驱动的任务队列
 * 无外部依赖（不依赖 BullMQ/Redis），直接使用 IDatabase 存储
 */

import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';

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

interface TaskRow {
  id: string;
  tenant_id: string;
  type: string;
  payload: string;
  status: string;
  result: string | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
  available_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
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

export class TaskQueue {
  private readonly workerId: string;

  constructor(private readonly db: IDatabase, workerId?: string) {
    this.workerId = workerId ?? generatePrefixedId('worker');
  }

  /** 入队新任务（priority: 0=普通, 1=高优先, 2=紧急） */
  enqueue(tenantId: string, type: string, payload: unknown, maxRetries = 3, priority = 0): string {
    const id = generatePrefixedId('task');
    const now = Date.now();
    this.db.prepare<void>(
      `INSERT INTO tasks (id, tenant_id, type, payload, status, retry_count, max_retries, created_at, updated_at, available_at, priority)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, type, JSON.stringify(payload), maxRetries, now, now, now, priority);
    return id;
  }

  /** 原子出队：优先级降序 + 时间升序，同一租户连续运行任务数受限（公平调度） */
  dequeue(now?: number): TaskRecord | undefined {
    const ts = now ?? Date.now();
    return this.db.transaction(() => {
      /* 按优先级降序、创建时间升序选取，同时统计各租户正在运行的任务数实现公平调度 */
      const row = this.db.prepare<TaskRow>(
        `SELECT t.* FROM tasks t
         LEFT JOIN (SELECT tenant_id, COUNT(*) as running_count FROM tasks WHERE status = 'running' GROUP BY tenant_id) r
         ON t.tenant_id = r.tenant_id
         WHERE t.status = 'pending' AND t.available_at <= ?
         ORDER BY t.priority DESC, COALESCE(r.running_count, 0) ASC, t.created_at ASC
         LIMIT 1`,
      ).get(ts);
      if (!row) return undefined;

      const updated = this.db.prepare<void>(
        `UPDATE tasks SET status = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(this.workerId, ts, ts, row.id);
      if (updated.changes === 0) return undefined;

      return rowToRecord({ ...row, status: 'running', claimed_by: this.workerId, claimed_at: ts, updated_at: ts });
    });
  }

  /** 标记任务完成 */
  complete(taskId: string, result: unknown): void {
    this.db.prepare<void>(
      `UPDATE tasks SET status = 'completed', result = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(result), Date.now(), taskId);
  }

  /** 标记任务失败 */
  fail(taskId: string, error: string): void {
    this.db.prepare<void>(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
    ).run(error, Date.now(), taskId);
  }

  /** 重新调度任务（指数退避） */
  reschedule(taskId: string, retryCount: number, availableAt: number, error: string): void {
    this.db.prepare<void>(
      `UPDATE tasks SET status = 'pending', retry_count = ?, available_at = ?, error = ?, updated_at = ? WHERE id = ?`,
    ).run(retryCount, availableAt, error, Date.now(), taskId);
  }

  /** 查询任务状态 */
  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare<TaskRow>(
      'SELECT * FROM tasks WHERE id = ?',
    ).get(taskId);
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * 回收卡死任务：将超时的 running 任务重置为 pending
   * @param staleThresholdMs 判定卡死的阈值（默认 5 分钟）
   * @returns 回收的任务数
   */
  reapStaleTasks(staleThresholdMs = 300_000): number {
    const now = Date.now();
    const cutoff = now - staleThresholdMs;
    const staleCondition = `status = 'running' AND ((claimed_at IS NOT NULL AND claimed_at < ?) OR (claimed_at IS NULL AND updated_at < ?))`;

    /* 可重试的任务：重置为 pending */
    const requeued = this.db.prepare<void>(
      `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, available_at = ?, updated_at = ?, retry_count = retry_count + 1
       WHERE ${staleCondition} AND retry_count < max_retries`,
    ).run(now, now, cutoff, cutoff);

    /* 已耗尽重试的任务：标记为 failed */
    const failed = this.db.prepare<void>(
      `UPDATE tasks SET status = 'failed', error = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE ${staleCondition} AND retry_count >= max_retries`,
    ).run('任务超时且已达到最大重试次数', now, cutoff, cutoff);

    return requeued.changes + failed.changes;
  }
}
