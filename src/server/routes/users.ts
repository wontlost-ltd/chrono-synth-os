/**
 * 用户个人路由
 * GET   /api/v1/users/me          — 获取当前用户信息
 * PATCH /api/v1/users/me          — 更新用户信息
 * PUT   /api/v1/users/me/password — 修改密码
 */

import type { FastifyInstance } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload, UserRow } from '../../types/auth.js';
import { AuthenticationError, ValidationError, ErrorCode } from '../../errors/index.js';

function userToProfile(row: UserRow) {
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    tenantId: row.tenant_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

export function registerUserRoutes(app: FastifyInstance, db: IDatabase): void {

  /* GET /api/v1/users/me */
  app.get('/api/v1/users/me', async (request) => {
    const user = request.user as JwtPayload;
    const row = db.prepare<UserRow>(
      'SELECT id, email, role, tenant_id, created_at FROM users WHERE id = ?',
    ).get(user.sub);
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return { data: userToProfile(row) };
  });

  /* PATCH /api/v1/users/me */
  app.patch('/api/v1/users/me', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { email?: string };

    if (body.email) {
      const existing = db.prepare<{ id: string }>('SELECT id FROM users WHERE email = ? AND id != ?').get(body.email, user.sub);
      if (existing) {
        throw new ValidationError('该邮箱已被使用', ErrorCode.AUTH_EMAIL_EXISTS);
      }
      db.prepare<void>('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(body.email, Date.now(), user.sub);
    }

    const row = db.prepare<UserRow>(
      'SELECT id, email, role, tenant_id, created_at FROM users WHERE id = ?',
    ).get(user.sub);
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return { data: userToProfile(row) };
  });

  /* PUT /api/v1/users/me/password */
  app.put('/api/v1/users/me/password', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { currentPassword: string; newPassword: string };

    if (!body.currentPassword || !body.newPassword) {
      throw new ValidationError('缺少必要参数', ErrorCode.VALIDATION_RANGE);
    }
    if (body.newPassword.length < 8) {
      throw new ValidationError('新密码长度至少 8 个字符', ErrorCode.VALIDATION_RANGE);
    }

    const row = db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(user.sub);
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);

    const valid = await verify(row.password_hash, body.currentPassword);
    if (!valid) {
      throw new ValidationError('当前密码错误', ErrorCode.VALIDATION_RANGE);
    }

    const newHash = await hash(body.newPassword);
    db.prepare<void>('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, Date.now(), user.sub);

    return { data: { success: true } };
  });
}
