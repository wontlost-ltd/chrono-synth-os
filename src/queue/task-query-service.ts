/**
 * 任务查询 Application Service
 * 封装任务状态查询与控制的业务逻辑，路由层只做请求解析和响应序列化
 */

import type { TaskQueue } from './task-queue.js';
import type { TaskWorker } from './task-worker.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

function safeJsonParse(json: string | null | undefined, fallback: unknown = null): unknown {
  if (!json) return fallback;
  try { return JSON.parse(json); }
  catch { return fallback; }
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

export class TaskQueryService {
  constructor(
    private readonly queue: TaskQueue,
    private readonly worker: TaskWorker | undefined,
    private readonly personaCoreService: PersonaCoreService | null,
  ) {}

  getTask(tenantId: string, taskId: string): Record<string, unknown> {
    /* marketplace 任务走 PersonaCoreService */
    if (taskId.startsWith('mkt_') && this.personaCoreService) {
      const task = this.personaCoreService.getMarketplaceTaskById(tenantId, taskId);
      if (!task) throw new NotFoundError(`任务 ${taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
      return {
        ...task,
        publishedAt: toIso(task.publishedAt),
        acceptedAt: toIso(task.acceptedAt),
        completedAt: toIso(task.completedAt),
        createdAt: toIso(task.createdAt),
        updatedAt: toIso(task.updatedAt),
      };
    }

    const task = this.queue.getTask(taskId);
    if (!task) throw new NotFoundError(`任务 ${taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    /* 租户隔离：非本租户的任务不可见 */
    if (task.tenantId !== tenantId) throw new NotFoundError(`任务 ${taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);

    return {
      id: task.id,
      type: task.type,
      status: task.status,
      result: task.result ? safeJsonParse(task.result) : null,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  cancelTask(tenantId: string, taskId: string): { taskId: string; cancelled: boolean } {
    const task = this.queue.getTask(taskId);
    if (!task) throw new NotFoundError(`任务 ${taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    if (task.tenantId !== tenantId) throw new NotFoundError(`任务 ${taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);

    const cancelled = this.worker?.cancelTask(taskId) ?? false;
    if (cancelled) {
      this.queue.fail(taskId, '用户取消');
    }
    return { taskId, cancelled };
  }
}
