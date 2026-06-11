/**
 * 任务队列 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const TASK_QUERY_BY_ID = 'task-queue.get-by-id' as const;
/** tenant-facing 读：SQL 层 tenant 隔离（防御纵深，#124）。worker 仍用 by-id。 */
export const TASK_QUERY_BY_ID_AND_TENANT = 'task-queue.get-by-id-and-tenant' as const;
export const TASK_QUERY_DEQUEUE_CANDIDATE = 'task-queue.dequeue-candidate' as const;
export const TASK_QUERY_EXPIRED_IDS = 'task-queue.expired-ids' as const;

/* ── Command Kinds ── */

export const TASK_CMD_ENQUEUE = 'task-queue.enqueue' as const;
export const TASK_CMD_CLAIM = 'task-queue.claim' as const;
export const TASK_CMD_COMPLETE = 'task-queue.complete' as const;
export const TASK_CMD_FAIL = 'task-queue.fail' as const;
export const TASK_CMD_RESCHEDULE = 'task-queue.reschedule' as const;
export const TASK_CMD_DELETE_BATCH = 'task-queue.delete-batch' as const;
export const TASK_CMD_REAP_RETRYABLE = 'task-queue.reap-retryable' as const;
export const TASK_CMD_REAP_EXHAUSTED = 'task-queue.reap-exhausted' as const;

/* ── 共享类型 ── */

export interface TaskRow {
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

/* ── 参数类型 ── */

export interface TaskEnqueueParams {
  id: string;
  tenantId: string;
  type: string;
  payload: string;
  maxRetries: number;
  now: number;
  priority: number;
  maxPending: number;
}

export interface TaskClaimParams {
  taskId: string;
  workerId: string;
  now: number;
}

export interface TaskCompleteParams {
  taskId: string;
  result: string;
  now: number;
}

export interface TaskFailParams {
  taskId: string;
  error: string;
  now: number;
}

export interface TaskRescheduleParams {
  taskId: string;
  retryCount: number;
  availableAt: number;
  error: string;
  now: number;
}

export interface TaskDeleteBatchParams {
  ids: string[];
}

export interface TaskReapParams {
  now: number;
  cutoff: number;
  errorMessage?: string;
}

export interface TaskExpiredIdsParams {
  cutoff: number;
  batchSize: number;
}

/** tenant-facing get：id + tenant 双约束（#124）。 */
export interface TaskByIdAndTenantParams {
  taskId: string;
  tenantId: string;
}

/* ── Query 工厂 ── */

export function taskQueryById(taskId: string): Query<TaskRow | null, string> {
  return { kind: TASK_QUERY_BY_ID, params: taskId };
}

/** tenant-facing 读：SQL 层 tenant 隔离（#124）。供 TaskQueryService 的 getTask/cancelTask。 */
export function taskQueryByIdAndTenant(params: TaskByIdAndTenantParams): Query<TaskRow | null, TaskByIdAndTenantParams> {
  return { kind: TASK_QUERY_BY_ID_AND_TENANT, params };
}

export function taskQueryDequeueCandidate(availableAt: number): Query<TaskRow | null, number> {
  return { kind: TASK_QUERY_DEQUEUE_CANDIDATE, params: availableAt };
}

export function taskQueryExpiredIds(cutoff: number, batchSize: number): Query<{ id: string }, TaskExpiredIdsParams> {
  return { kind: TASK_QUERY_EXPIRED_IDS, params: { cutoff, batchSize } };
}

/* ── Command 工厂 ── */

export function taskCmdEnqueue(params: TaskEnqueueParams): Command<TaskEnqueueParams> {
  return { kind: TASK_CMD_ENQUEUE, params };
}

export function taskCmdClaim(params: TaskClaimParams): Command<TaskClaimParams> {
  return { kind: TASK_CMD_CLAIM, params };
}

export function taskCmdComplete(params: TaskCompleteParams): Command<TaskCompleteParams> {
  return { kind: TASK_CMD_COMPLETE, params };
}

export function taskCmdFail(params: TaskFailParams): Command<TaskFailParams> {
  return { kind: TASK_CMD_FAIL, params };
}

export function taskCmdReschedule(params: TaskRescheduleParams): Command<TaskRescheduleParams> {
  return { kind: TASK_CMD_RESCHEDULE, params };
}

export function taskCmdDeleteBatch(ids: string[]): Command<TaskDeleteBatchParams> {
  return { kind: TASK_CMD_DELETE_BATCH, params: { ids } };
}

export function taskCmdReapRetryable(params: TaskReapParams): Command<TaskReapParams> {
  return { kind: TASK_CMD_REAP_RETRYABLE, params };
}

export function taskCmdReapExhausted(params: TaskReapParams): Command<TaskReapParams> {
  return { kind: TASK_CMD_REAP_EXHAUSTED, params };
}
