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
  };
}

export class TaskQueue {
  constructor(private readonly db: IDatabase) {}

  /** 入队新任务 */
  enqueue(tenantId: string, type: string, payload: unknown, maxRetries = 3): string {
    const id = generatePrefixedId('task');
    const now = Date.now();
    this.db.prepare<void>(
      `INSERT INTO tasks (id, tenant_id, type, payload, status, retry_count, max_retries, created_at, updated_at, available_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    ).run(id, tenantId, type, JSON.stringify(payload), maxRetries, now, now, now);
    return id;
  }

  /** 原子出队：获取并锁定一个可执行的任务 */
  dequeue(now?: number): TaskRecord | undefined {
    const ts = now ?? Date.now();
    return this.db.transaction(() => {
      const row = this.db.prepare<TaskRow>(
        `SELECT * FROM tasks WHERE status = 'pending' AND available_at <= ? ORDER BY created_at ASC LIMIT 1`,
      ).get(ts);
      if (!row) return undefined;

      this.db.prepare<void>(
        `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      ).run(ts, row.id);

      return rowToRecord({ ...row, status: 'running', updated_at: ts });
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
}
