/**
 * 任务状态查询与控制路由
 * 路由层只做请求解析和响应序列化，业务逻辑委托 TaskQueryService
 */

import type { FastifyInstance } from 'fastify';
import type { TaskQueue } from '../../queue/task-queue.js';
import type { TaskWorker } from '../../queue/task-worker.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { TaskQueryService } from '../../queue/task-query-service.js';

/** 任务路由依赖（分片 Phase 0 · Plan 1：resolver 必填，PersonaCoreService 经它路由 shard）。 */
export interface TaskRoutesDeps {
  queue: TaskQueue;
  worker?: TaskWorker;
  /** 共享 TenantDbResolver（组合根唯一实例）。 */
  resolver: TenantDbResolver;
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRoutesDeps): void {
  const { queue, worker, resolver } = deps;
  const personaCoreService = PersonaCoreService.fromResolver(resolver);
  const service = new TaskQueryService(queue, worker, personaCoreService);

  /* GET /api/v1/tasks/:taskId — 查询异步任务状态 */
  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId', async (request) => {
    return { data: service.getTask(request.tenantId, request.params.taskId) };
  });

  /* POST /api/v1/tasks/:taskId/cancel — 取消正在执行的任务 */
  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/cancel', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    return { data: service.cancelTask(request.tenantId, request.params.taskId) };
  });
}
