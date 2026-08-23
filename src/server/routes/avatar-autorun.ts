/**
 * Avatar 自动运行路由
 * 路由层只做请求解析和响应序列化，业务逻辑委托 AvatarAutorunFacade
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import type { AvatarAutorunService } from '../../identity/avatar-autorun-service.js';
import { AvatarAutorunFacade } from '../../identity/avatar-autorun-facade.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { IdentityService } from '../../identity/identity-service.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import type { JwtPayload } from '../../types/auth.js';
import { UpsertAutorunConfigSchema, TriggerAutorunSchema, DriftReviewSchema } from '../schemas/api-schemas.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerAvatarAutorunRoutes(
  app: FastifyInstance,
  db: IDatabase,
  resolver: TenantDbResolver,
  autorunService: AvatarAutorunService | undefined,
): void {
  /* 分片 Plan 1b（Task 2）：facade 的 AvatarService 经共享 resolver 按 tenantId 路由；autorun store 仍持 db。 */
  const facade = new AvatarAutorunFacade(db, resolver, autorunService);
  const identityService = new IdentityService(resolver);
  const avatarService = new AvatarService(resolver);

  /**
   * 审计 Warning #14：**租户内**的分身归属校验。
   *
   * 此前本文件 7 个端点只用 `request.tenantId`，不校验调用者是否拥有该 avatar ——
   * 同一租户下的 user-1 拿 user-2 的 avatarId 即可读写其自动运行配置（实测：
   * GET autorun / GET runs 均 200，PUT autorun 返回 200 **并真的改掉了受害者的配置**）。
   * 而同目录的 `avatars.ts` 早有 `requireOwnedAvatar` —— 普通 CRUD 对同一 ID 正确返回 404。
   * 也就是说 autorun 这组端点是**绕过既有守卫的旁路**，故此处复用同款语义。
   *
   * 语义与 `avatars.ts` 对齐：查不到（不存在 or 不属于调用者）一律 404，**不泄露存在性**。
   */
  function requireOwnedAvatar(request: FastifyRequest, avatarId: string): void {
    const user = request.user as JwtPayload | undefined;
    /* 无 JWT 身份（如平台/静态 key 调用）时无从判定归属 —— fail-closed 拒。 */
    if (!user?.sub) throw new NotFoundError(`分身 ${avatarId} 不存在`, ErrorCode.NOT_FOUND_AVATAR);
    const identity = identityService.getByUser(request.tenantId, user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatar = avatarService.getByIdForIdentity(request.tenantId, avatarId, identity.id);
    if (!avatar) throw new NotFoundError(`分身 ${avatarId} 不存在`, ErrorCode.NOT_FOUND_AVATAR);
  }

  /* GET /api/v1/avatars/:id/autorun — 获取自动运行配置 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun', async (request) => {
    requireOwnedAvatar(request, request.params.id);
    return { data: facade.getConfig(request.tenantId, request.params.id) };
  });

  /* PUT /api/v1/avatars/:id/autorun — 创建/更新自动运行配置 */
  app.put<{ Params: { id: string } }>('/api/v1/avatars/:id/autorun', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    requireOwnedAvatar(request, request.params.id);
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
    requireOwnedAvatar(request, request.params.id);
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
    requireOwnedAvatar(request, request.params.id);
    const params = parsePagination(request.query as Record<string, unknown>);
    const result = facade.listRuns(request.tenantId, request.params.id, params.page, params.pageSize);
    return { data: result.data, pagination: result.pagination };
  });

  /* GET /api/v1/avatars/:id/drift — 漂移指标 */
  app.get<{ Params: { id: string } }>('/api/v1/avatars/:id/drift', async (request) => {
    requireOwnedAvatar(request, request.params.id);
    return { data: facade.getDrift(request.tenantId, request.params.id) };
  });

  /* POST /api/v1/avatars/:id/drift/review — 提交漂移审查 */
  app.post<{ Params: { id: string } }>('/api/v1/avatars/:id/drift/review', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    requireOwnedAvatar(request, request.params.id);
    DriftReviewSchema.parse(request.body);
    const result = facade.submitDriftReview();
    app.log.info({ tenantId: request.tenantId, avatarId: request.params.id, reviewId: result.reviewId }, '漂移审查已提交');
    return { data: result };
  });
}
