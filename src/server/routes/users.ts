/**
 * 用户个人路由
 * GET   /api/v1/users/me          — 获取当前用户信息
 * PATCH /api/v1/users/me          — 更新用户信息
 * PUT   /api/v1/users/me/password — 修改密码
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { UserProfileService } from '../../identity/user-profile-service.js';

export function registerUserRoutes(app: FastifyInstance, db: IDatabase): void {
  const service = new UserProfileService(db);

  app.get('/api/v1/users/me', async (request) => {
    const user = request.user as JwtPayload;
    return { data: service.getProfile(user.sub) };
  });

  app.patch('/api/v1/users/me', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { email?: string };
    if (body.email) {
      return { data: service.updateEmail(user.sub, body.email) };
    }
    return { data: service.getProfile(user.sub) };
  });

  app.put('/api/v1/users/me/password', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { currentPassword: string; newPassword: string };
    const result = await service.changePassword(user.sub, body.currentPassword, body.newPassword);
    return { data: result };
  });
}
