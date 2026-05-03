/**
 * 身份路由
 * GET   /api/v1/identity       — 获取当前用户身份
 * PATCH /api/v1/identity       — 更新身份元数据
 */

import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import type { JwtPayload } from '../../types/auth.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { UpdateIdentitySchema } from '../schemas/api-schemas.js';

export function registerIdentityRoutes(app: FastifyInstance, services: AppServices): void {
  const { identity: identityService } = services;

  /* GET /api/v1/identity */
  app.get('/api/v1/identity', async (request) => {
    const user = request.user as JwtPayload;
    const identity = identityService.getByUser(user.sub);
    if (!identity) {
      throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    }
    return { data: identity };
  });

  /* PATCH /api/v1/identity */
  app.patch('/api/v1/identity', async (request) => {
    const user = request.user as JwtPayload;
    const body = UpdateIdentitySchema.parse(request.body);
    const identity = identityService.getByUser(user.sub);
    if (!identity) {
      throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    }
    const updated = identityService.update(identity.id, body);
    return { data: updated };
  });
}
