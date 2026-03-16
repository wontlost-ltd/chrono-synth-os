/**
 * API Key 管理路由
 * POST   /api/v1/api-keys      — 创建新 API Key（返回明文，仅此一次）
 * GET    /api/v1/api-keys      — 列出当前租户的所有 API Key（不含明文）
 * DELETE /api/v1/api-keys/:id  — 吊销指定 API Key
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { CreateApiKeySchema } from '../schemas/api-schemas.js';
import { AuthenticationError, ErrorCode } from '../../errors/index.js';
import { ApiKeyService } from '../../billing/api-key-service.js';

export function registerApiKeyRoutes(app: FastifyInstance, db: IDatabase): void {
  const apiKeyService = new ApiKeyService(db);

  /* POST /api/v1/api-keys — 创建 */
  app.post('/api/v1/api-keys', async (request, reply) => {
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (!user?.sub) {
      throw new AuthenticationError('需要认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    /* 仅 admin 可创建 API Key */
    if (user.role !== 'admin') {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INSUFFICIENT_ROLE',
        message: '仅管理员可创建 API Key',
      });
    }

    const body = CreateApiKeySchema.parse(request.body);
    const tenantId = user.tenantId ?? 'default';

    const outcome = apiKeyService.create(tenantId, body.planId);
    if (!outcome.ok) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'PLAN_MISMATCH',
        message: `API Key 计划必须与当前订阅一致（当前: ${outcome.tenantPlanId}）`,
      });
    }

    return reply.status(201).send({ data: outcome.data });
  });

  /* GET /api/v1/api-keys — 列出（仅管理员） */
  app.get('/api/v1/api-keys', async (request, reply) => {
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (!user?.sub) {
      throw new AuthenticationError('需要认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    if (user.role !== 'admin') {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INSUFFICIENT_ROLE',
        message: '仅管理员可查看 API Key 列表',
      });
    }

    const tenantId = user.tenantId ?? 'default';
    return { data: apiKeyService.list(tenantId) };
  });

  /* DELETE /api/v1/api-keys/:id — 吊销 */
  app.delete<{ Params: { id: string } }>('/api/v1/api-keys/:id', async (request, reply) => {
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (!user?.sub) {
      throw new AuthenticationError('需要认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    if (user.role !== 'admin') {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INSUFFICIENT_ROLE',
        message: '仅管理员可吊销 API Key',
      });
    }

    const tenantId = user.tenantId ?? 'default';
    const { id } = request.params;

    if (!apiKeyService.revoke(id, tenantId)) {
      return reply.status(404).send({
        error: 'NotFoundError',
        code: 'API_KEY_NOT_FOUND',
        message: 'API Key 不存在或已吊销',
      });
    }

    return reply.status(200).send({ data: { id, revoked: true } });
  });
}
