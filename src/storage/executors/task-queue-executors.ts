/**
 * 任务队列 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  TaskRow, TaskEnqueueParams, TaskClaimParams, TaskCompleteParams,
  TaskFailParams, TaskRescheduleParams, TaskDeleteBatchParams,
  TaskReapParams, TaskExpiredIdsParams,
} from '@chrono/kernel';
import {
  TASK_QUERY_BY_ID, TASK_QUERY_DEQUEUE_CANDIDATE, TASK_QUERY_EXPIRED_IDS,
  TASK_CMD_ENQUEUE, TASK_CMD_CLAIM, TASK_CMD_COMPLETE, TASK_CMD_FAIL,
  TASK_CMD_RESCHEDULE, TASK_CMD_DELETE_BATCH, TASK_CMD_REAP_RETRYABLE,
  TASK_CMD_REAP_EXHAUSTED,
} from '@chrono/kernel';

export function registerTaskQueueExecutors(): void {
  /* ── Queries ── */

  registerQuery<TaskRow | null, string>(TASK_QUERY_BY_ID, (db, taskId) => {
    return db.prepare<TaskRow>('SELECT * FROM tasks WHERE id = ?').get(taskId) ?? null;
  });

  registerQuery<TaskRow | null, number>(TASK_QUERY_DEQUEUE_CANDIDATE, (db, availableAt) => {
    return db.prepare<TaskRow>(
      `SELECT t.* FROM tasks t
       LEFT JOIN (SELECT tenant_id, COUNT(*) as running_count FROM tasks WHERE status = 'running' GROUP BY tenant_id) r
       ON t.tenant_id = r.tenant_id
       WHERE t.status = 'pending' AND t.available_at <= ?
       ORDER BY t.priority DESC, COALESCE(r.running_count, 0) ASC, t.created_at ASC
       LIMIT 1`,
    ).get(availableAt) ?? null;
  });

  registerQuery<readonly { id: string }[], TaskExpiredIdsParams>(TASK_QUERY_EXPIRED_IDS, (db, params) => {
    return db.prepare<{ id: string }>(
      `SELECT id FROM tasks WHERE status IN ('completed', 'failed') AND updated_at < ? LIMIT ?`,
    ).all(params.cutoff, params.batchSize);
  });

  /* ── Commands ── */

  registerCommand<TaskEnqueueParams>(TASK_CMD_ENQUEUE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tasks (id, tenant_id, type, payload, status, retry_count, max_retries, created_at, updated_at, available_at, priority)
       SELECT ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?
       WHERE ? = 0 OR (SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND status IN ('pending', 'running')) < ?`,
    ).run(p.id, p.tenantId, p.type, p.payload, p.maxRetries, p.now, p.now, p.now, p.priority, p.maxPending, p.tenantId, p.maxPending);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskClaimParams>(TASK_CMD_CLAIM, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(p.workerId, p.now, p.now, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskCompleteParams>(TASK_CMD_COMPLETE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'completed', result = ?, updated_at = ? WHERE id = ?`,
    ).run(p.result, p.now, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskFailParams>(TASK_CMD_FAIL, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
    ).run(p.error, p.now, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskRescheduleParams>(TASK_CMD_RESCHEDULE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'pending', retry_count = ?, available_at = ?, error = ?, updated_at = ? WHERE id = ?`,
    ).run(p.retryCount, p.availableAt, p.error, p.now, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskDeleteBatchParams>(TASK_CMD_DELETE_BATCH, (db, p) => {
    if (p.ids.length === 0) return { rowsAffected: 0 };
    const placeholders = p.ids.map(() => '?').join(',');
    const result = db.prepare<void>(
      `DELETE FROM tasks WHERE id IN (${placeholders})`,
    ).run(...p.ids);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskReapParams>(TASK_CMD_REAP_RETRYABLE, (db, p) => {
    const staleCondition = `status = 'running' AND ((claimed_at IS NOT NULL AND claimed_at < ?) OR (claimed_at IS NULL AND updated_at < ?))`;
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, available_at = ?, updated_at = ?, retry_count = retry_count + 1
       WHERE ${staleCondition} AND retry_count < max_retries`,
    ).run(p.now, p.now, p.cutoff, p.cutoff);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskReapParams>(TASK_CMD_REAP_EXHAUSTED, (db, p) => {
    const staleCondition = `status = 'running' AND ((claimed_at IS NOT NULL AND claimed_at < ?) OR (claimed_at IS NULL AND updated_at < ?))`;
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'failed', error = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE ${staleCondition} AND retry_count >= max_retries`,
    ).run(p.errorMessage ?? '任务超时且已达到最大重试次数', p.now, p.cutoff, p.cutoff);
    return { rowsAffected: result.changes };
  });
}
