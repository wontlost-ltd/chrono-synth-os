/**
 * 任务状态查询与控制路由
 * GET /api/v1/tasks/:taskId — 查询异步任务状态
 * POST /api/v1/tasks/:taskId/cancel — 取消正在执行的任务
 */

import type { FastifyInstance } from 'fastify';
import type { TaskQueue } from '../../queue/task-queue.js';
import type { TaskWorker } from '../../queue/task-worker.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';

function safeJsonParse(json: string | null | undefined, fallback: unknown = null): unknown {
  if (!json) return fallback;
  try { return JSON.parse(json); }
  catch { return fallback; }
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

export function registerTaskRoutes(app: FastifyInstance, queue: TaskQueue, worker?: TaskWorker, db?: IDatabase): void {
  const personaCoreService = db ? new PersonaCoreService(db) : null;

  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId', async (request) => {
    if (request.params.taskId.startsWith('mkt_') && personaCoreService) {
      const task = personaCoreService.getMarketplaceTaskById(request.tenantId, request.params.taskId);
      if (!task) {
        throw new NotFoundError(`任务 ${request.params.taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
      }
      return {
        data: {
          ...task,
          publishedAt: toIso(task.publishedAt),
          acceptedAt: toIso(task.acceptedAt),
          completedAt: toIso(task.completedAt),
          createdAt: toIso(task.createdAt),
          updatedAt: toIso(task.updatedAt),
        },
      };
    }

    const task = queue.getTask(request.params.taskId);
    if (!task) {
      throw new NotFoundError(`任务 ${request.params.taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    /* 租户隔离：非本租户的任务不可见 */
    if (task.tenantId !== request.tenantId) {
      throw new NotFoundError(`任务 ${request.params.taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    return {
      data: {
        id: task.id,
        type: task.type,
        status: task.status,
        result: task.result ? safeJsonParse(task.result) : null,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    };
  });

  /* POST /api/v1/tasks/:taskId/cancel — 取消正在执行的任务 */
  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/cancel', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const task = queue.getTask(request.params.taskId);
    if (!task) {
      throw new NotFoundError(`任务 ${request.params.taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    if (task.tenantId !== request.tenantId) {
      throw new NotFoundError(`任务 ${request.params.taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    const cancelled = worker?.cancelTask(request.params.taskId) ?? false;
    if (cancelled) {
      queue.fail(request.params.taskId, '用户取消');
    }
    return { data: { taskId: request.params.taskId, cancelled } };
  });
}
