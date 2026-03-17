/**
 * Avatar 自动运行路由
 * 路由层只做请求解析和响应序列化，业务逻辑委托 AvatarAutorunFacade
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AvatarAutorunService } from '../../identity/avatar-autorun-service.js';
import { AvatarAutorunFacade } from '../../identity/avatar-autorun-facade.js';
import { UpsertAutorunConfigSchema, TriggerAutorunSchema, DriftReviewSchema } from '../schemas/api-schemas.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerAvatarAutorunRoutes(
  app: FastifyInstance,
  db: IDatabase,
  autorunService: AvatarAutorunService | undefined,
): void {
  const facade = new AvatarAutorunFacade(db, autorunService);

  /* GET /api/v1/avatars/:id/autorun — 获取自动运行配置 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun', async (request) => {
    return { data: facade.getConfig(request.tenantId, request.params.id) };
  });

  /* PUT /api/v1/avatars/:id/autorun — 创建/更新自动运行配置 */
  app.put<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    const body = UpsertAutorunConfigSchema.parse(request.body);
    return { data: facade.upsertConfig(request.tenantId, request.params.id, {
      enabled: body.enabled,
      intervalMinutes: body.intervalMinutes,
      driftThreshold: body.driftThreshold,
      reviewRequired: body.reviewRequired,
      knowledgeSourceIds: body.knowledgeSourceIds,
    }) };
  });

  /* POST /api/v1/avatars/:id/autorun/run 及 /trigger — 手动触发运行 */
  const triggerHandler = async (request: FastifyRequest<{ Params: { id: string } }>) => {
    TriggerAutorunSchema.parse(request.body);
    const result = facade.triggerRun(request.tenantId, request.params.id);
    if (!result.ok) return { data: null, error: result.error };
    return { data: { runId: result.runId, taskId: result.taskId } };
  };
  const triggerOpts = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun/run', triggerOpts, triggerHandler);
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun/trigger', triggerOpts, triggerHandler);

  /* GET /api/v1/avatars/:id/autorun/runs — 运行历史 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun/runs', async (request) => {
    const params = parsePagination(request.query as Record<string, unknown>);
    const result = facade.listRuns(request.tenantId, request.params.id, params.page, params.pageSize);
    return { data: result.data, pagination: result.pagination };
  });

  /* GET /api/v1/avatars/:id/drift — 漂移指标 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/drift', async (request) => {
    return { data: facade.getDrift(request.tenantId, request.params.id) };
  });

  /* POST /api/v1/avatars/:id/drift/review — 提交漂移审查 */
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/drift/review', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    DriftReviewSchema.parse(request.body);
    const result = facade.submitDriftReview();
    app.log.info({ tenantId: request.tenantId, avatarId: request.params.id, reviewId: result.reviewId }, '漂移审查已提交');
    return { data: result };
  });
}
