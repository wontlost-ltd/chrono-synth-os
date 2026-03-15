/**
 * Avatar 自动运行路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AvatarAutorunService } from '../../identity/avatar-autorun-service.js';
import { AvatarAutorunStore } from '../../storage/avatar-autorun-store.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { UpsertAutorunConfigSchema, TriggerAutorunSchema, DriftReviewSchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { parsePagination } from '../plugins/pagination.js';
import { generatePrefixedId } from '../../utils/id-generator.js';

export function registerAvatarAutorunRoutes(
  app: FastifyInstance,
  db: IDatabase,
  autorunService: AvatarAutorunService | undefined,
): void {
  const store = new AvatarAutorunStore(db);
  const avatarService = new AvatarService(db);

  /* GET /api/v1/avatars/:id/autorun — 获取自动运行配置 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun', async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;

    const avatar = avatarService.getById(id);
    if (!avatar) throw new NotFoundError(`Avatar ${id} 不存在`, ErrorCode.NOT_FOUND_AVATAR);

    const config = store.getConfig(tenantId, id);
    if (!config) return { data: null };
    return {
      data: {
        ...config,
        intervalMinutes: Math.round(config.intervalMs / 60_000),
      },
    };
  });

  /* PUT /api/v1/avatars/:id/autorun — 创建/更新自动运行配置 */
  app.put<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;
    const body = UpsertAutorunConfigSchema.parse(request.body);

    const avatar = avatarService.getById(id);
    if (!avatar) throw new NotFoundError(`Avatar ${id} 不存在`, ErrorCode.NOT_FOUND_AVATAR);

    const config = store.upsertConfig(tenantId, id, {
      enabled: body.enabled,
      intervalMs: body.intervalMinutes * 60 * 1000,
      driftThreshold: body.driftThreshold,
      reviewRequired: body.reviewRequired,
      knowledgeSourceIds: body.knowledgeSourceIds,
    });

    return { data: config };
  });

  /* POST /api/v1/avatars/:id/autorun/run 及 /trigger — 手动触发运行 */
  const triggerHandler = async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    const tenantId = request.tenantId;
    TriggerAutorunSchema.parse(request.body);

    if (!autorunService) {
      return { data: null, error: '自动运行服务未启用（需启用任务队列）' };
    }

    const avatar = avatarService.getById(id);
    if (!avatar) throw new NotFoundError(`Avatar ${id} 不存在`, ErrorCode.NOT_FOUND_AVATAR);

    const config = store.getConfig(tenantId, id);
    if (!config) throw new NotFoundError(`Avatar ${id} 未配置自动运行`, ErrorCode.NOT_FOUND_AVATAR);

    const { runId, taskId } = autorunService.enqueueRun(config.id, tenantId, id);
    return { data: { runId, taskId } };
  };
  const triggerOpts = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun/run', triggerOpts, triggerHandler);
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun/trigger', triggerOpts, triggerHandler);

  /* GET /api/v1/avatars/:id/autorun/runs — 运行历史 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun/runs', async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;
    const query = request.query as Record<string, unknown>;
    const params = parsePagination(query);
    const offset = (params.page - 1) * params.pageSize;

    const { runs, total } = store.listRunsByAvatar(tenantId, id, params.pageSize, offset);
    return {
      data: runs,
      pagination: { page: params.page, pageSize: params.pageSize, total, totalPages: Math.ceil(total / params.pageSize) || 1 },
    };
  });

  /* GET /api/v1/avatars/:id/drift — 漂移指标 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/drift', async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;

    const config = store.getConfig(tenantId, id);
    if (!config) return { data: null };

    /* 从最新完成的运行日志获取漂移分数 */
    const { runs } = store.listRunsByAvatar(tenantId, id, 1, 0);
    const latestRun = runs.find(r => r.status === 'completed');

    return {
      data: {
        avatarId: id,
        driftScore: latestRun?.metrics?.driftScore ?? 0,
        driftThreshold: config.driftThreshold,
        lastEvaluatedAt: config.lastDriftCheckAt,
      },
    };
  });

  /* POST /api/v1/avatars/:id/drift/review — 提交漂移审查 */
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/drift/review', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;
    DriftReviewSchema.parse(request.body);

    const reviewId = generatePrefixedId('drv');
    app.log.info({ tenantId, avatarId: id, reviewId }, '漂移审查已提交');

    return { data: { reviewId, status: 'applied' } };
  });
}
