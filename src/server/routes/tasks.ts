/**
 * 任务状态查询路由
 * GET /api/v1/tasks/:taskId — 查询异步任务状态
 */

import type { FastifyInstance } from 'fastify';
import type { TaskQueue } from '../../queue/task-queue.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';

export function registerTaskRoutes(app: FastifyInstance, queue: TaskQueue): void {
  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId', async (request) => {
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
        result: task.result ? JSON.parse(task.result) : null,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    };
  });
}
