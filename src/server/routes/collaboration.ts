/**
 * 协作路由
 * POST   /api/v1/simulations/:id/share          — 分享模拟给其他用户
 * GET    /api/v1/simulations/:id/shares          — 列某模拟分享给了谁（owner 视角）
 * GET    /api/v1/shared                           — 获取分享给我的模拟列表
 * DELETE /api/v1/simulations/:id/share/:userId    — 取消分享（按 targetUserId）
 */

import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import { ShareSimulationSchema, PaginationQuerySchema } from '../schemas/api-schemas.js';
import { AuthenticationError, ErrorCode } from '../../errors/index.js';

export function registerCollaborationRoutes(app: FastifyInstance, services: AppServices): void {
  const { collaboration: service } = services;

  app.post<{ Params: { id: string } }>('/api/v1/simulations/:id/share', async (request, reply) => {
    const { id: simulationId } = request.params;
    const ownerUserId = (request.user as { sub?: string })?.sub;
    if (!ownerUserId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const { userId, permission } = ShareSimulationSchema.parse(request.body);
    const result = service.share(simulationId, ownerUserId, request.tenantId, userId, permission);
    return result.created ? reply.status(201).send({ data: result }) : { data: result };
  });

  app.get<{ Params: { id: string } }>('/api/v1/simulations/:id/shares', async (request) => {
    const { id: simulationId } = request.params;
    const requesterUserId = (request.user as { sub?: string })?.sub;
    if (!requesterUserId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }
    const data = service.listSharesForSimulation(simulationId, requesterUserId, request.tenantId);
    return { data };
  });

  app.get('/api/v1/shared', async (request) => {
    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const { data, total } = service.listSharedWithUser(userId, page, pageSize);
    return {
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/v1/simulations/:id/share/:userId', async (request, reply) => {
    const { id: simulationId, userId } = request.params;
    const ownerUserId = (request.user as { sub?: string })?.sub;
    if (!ownerUserId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }

    service.unshare(simulationId, userId, ownerUserId, request.tenantId);
    return reply.status(204).send();
  });
}
