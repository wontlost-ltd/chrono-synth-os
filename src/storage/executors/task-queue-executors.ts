/**
 * 任务队列 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import { dbNowMs } from './db-now.js';
import type {
  TaskRow, TaskEnqueueParams, TaskClaimParams, TaskCompleteParams,
  TaskFailParams, TaskRescheduleParams, TaskDeleteBatchParams,
  TaskReapParams, TaskExpiredIdsParams, TaskByIdAndTenantParams,
} from '@chrono/kernel';
import {
  TASK_QUERY_BY_ID, TASK_QUERY_BY_ID_AND_TENANT, TASK_QUERY_DEQUEUE_CANDIDATE, TASK_QUERY_EXPIRED_IDS,
  TASK_CMD_ENQUEUE, TASK_CMD_CLAIM, TASK_CMD_COMPLETE, TASK_CMD_FAIL,
  TASK_CMD_RESCHEDULE, TASK_CMD_DELETE_BATCH, TASK_CMD_REAP_RETRYABLE,
  TASK_CMD_REAP_EXHAUSTED,
} from '@chrono/kernel';

export function registerTaskQueueExecutors(): void {
  /* ── Queries ── */

  /* by-id（无 tenant 谓词）：仅供 worker/内部按 id 操作已 dequeue 的任务（worker 已全局取号）。
   * tenant-facing 的 get/cancel 必须用下面的 by-id-and-tenant，不得用本查询直接对外返回。 */
  registerQuery<TaskRow | null, string>(TASK_QUERY_BY_ID, (db, taskId) => {
    return db.prepare<TaskRow>('SELECT * FROM tasks WHERE id = ?').get(taskId) ?? null;
  });

  /* tenant-facing 读（#124 防御纵深）：SQL 层 id + tenant 双约束，跨租户 id 直接查不到 →
   * 隔离不再只靠应用层 post-read 检查。 */
  registerQuery<TaskRow | null, TaskByIdAndTenantParams>(TASK_QUERY_BY_ID_AND_TENANT, (db, p) => {
    return db.prepare<TaskRow>('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(p.taskId, p.tenantId) ?? null;
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

  /* issue #395：`claimed_at` 是 reaper 的判定依据，必须由**数据库**盖戳。
   * 认领在副本 A、回收在副本 B 时，应用侧时钟的钟差会直接平移 stale 判定。
   * `p.now` 仍保留在参数里供其他字段/调用方使用，但这两列不再用它。 */
  registerCommand<TaskClaimParams>(TASK_CMD_CLAIM, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'running', claimed_by = ?,
              claimed_at = ${dbNowMs(db)}, updated_at = ${dbNowMs(db)}
       WHERE id = ? AND status = 'pending'`,
    ).run(p.workerId, p.taskId);
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

  /* issue #395：截止点与写入时刻**都**由数据库求值，物理上消除多时钟。
   * 收的是时长（staleAfterMs）而非时刻，见 dbNowMs 与 TaskReapParams 的说明。
   *
   * `available_at` / `updated_at` 也改用 DB 时钟：若这里仍写应用侧 now，
   * 下一轮 reap 拿 DB 时钟去比一个应用侧写入的 `updated_at`，钟差原样回来。
   * 判据是「写入端与比较端同源」，不是「只把比较端换掉」。 */
  registerCommand<TaskReapParams>(TASK_CMD_REAP_RETRYABLE, (db, p) => {
    const staleCondition =
      `status = 'running' AND ((claimed_at IS NOT NULL AND claimed_at < ${dbNowMs(db)} - ?)`
      + ` OR (claimed_at IS NULL AND updated_at < ${dbNowMs(db)} - ?))`;
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
              available_at = ${dbNowMs(db)}, updated_at = ${dbNowMs(db)}, retry_count = retry_count + 1
       WHERE ${staleCondition} AND retry_count < max_retries`,
    ).run(p.staleAfterMs, p.staleAfterMs);
    return { rowsAffected: result.changes };
  });

  registerCommand<TaskReapParams>(TASK_CMD_REAP_EXHAUSTED, (db, p) => {
    const staleCondition =
      `status = 'running' AND ((claimed_at IS NOT NULL AND claimed_at < ${dbNowMs(db)} - ?)`
      + ` OR (claimed_at IS NULL AND updated_at < ${dbNowMs(db)} - ?))`;
    const result = db.prepare<void>(
      `UPDATE tasks SET status = 'failed', error = ?, claimed_by = NULL, claimed_at = NULL,
              updated_at = ${dbNowMs(db)}
       WHERE ${staleCondition} AND retry_count >= max_retries`,
    ).run(p.errorMessage ?? '任务超时且已达到最大重试次数', p.staleAfterMs, p.staleAfterMs);
    return { rowsAffected: result.changes };
  });
}
