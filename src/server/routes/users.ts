/**
 * 用户个人路由
 * GET   /api/v1/users/me          — 获取当前用户信息
 * PATCH /api/v1/users/me          — 更新用户信息
 * PUT   /api/v1/users/me/password — 修改密码
 */

import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import type { JwtPayload } from '../../types/auth.js';

export function registerUserRoutes(app: FastifyInstance, services: AppServices): void {
  const { userProfile: service, userEmailDirectory } = services;

  app.get('/api/v1/users/me', async (request) => {
    const user = request.user as JwtPayload;
    /* 分片 Plan 1b（Task 7）：tenant-scoped getProfile → JWT 带 tenantId。 */
    return { data: service.getProfile(user.tenantId, user.sub) };
  });

  app.patch('/api/v1/users/me', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { email?: string };
    if (body.email) {
      /* email 更新走 UserEmailDirectoryService（全局 email 唯一性，mixed-scope，coordinatorDb 过渡）。 */
      return { data: userEmailDirectory.updateEmail(user.sub, body.email) };
    }
    return { data: service.getProfile(user.tenantId, user.sub) };
  });

  app.put('/api/v1/users/me/password', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { currentPassword: string; newPassword: string };
    const result = await service.changePassword(user.tenantId, user.sub, body.currentPassword, body.newPassword);
    return { data: result };
  });
}
