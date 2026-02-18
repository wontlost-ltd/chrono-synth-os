/**
 * 协作路由
 * POST   /api/v1/simulations/:id/share          — 分享模拟给其他用户
 * GET    /api/v1/shared                           — 获取分享给我的模拟列表
 * DELETE /api/v1/simulations/:id/share/:userId    — 取消分享
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';
import { ShareSimulationSchema, PaginationQuerySchema } from '../schemas/api-schemas.js';
import { AuthenticationError, AuthorizationError, NotFoundError, ErrorCode } from '../../errors/index.js';

interface SharedRow {
  id: string;
  simulation_id: string;
  owner_user_id: string;
  shared_with_user_id: string;
  permission: string;
  created_at: number;
}

export function registerCollaborationRoutes(app: FastifyInstance, db: IDatabase): void {
  /* POST /api/v1/simulations/:id/share */
  app.post<{ Params: { id: string } }>('/api/v1/simulations/:id/share', async (request) => {
    const { id: simulationId } = request.params;
    const ownerUserId = (request.user as { sub?: string })?.sub;
    const tenantId = request.tenantId;

    if (!ownerUserId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const { userId, permission } = ShareSimulationSchema.parse(request.body);

    /* 验证模拟归属当前租户 */
    const simulation = db.prepare<{ tenant_id: string }>(
      'SELECT tenant_id FROM life_simulations WHERE id = ?',
    ).get(simulationId);
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }

    const existing = db.prepare<{ id: string; owner_user_id: string }>(
      'SELECT id, owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(simulationId, userId);

    if (existing) {
      if (existing.owner_user_id !== ownerUserId) {
        throw new AuthorizationError('无权限修改他人分享', ErrorCode.AUTH_INSUFFICIENT_ROLE);
      }
      db.prepare(
        'UPDATE shared_simulations SET permission = ?, updated_at = ? WHERE id = ?',
      ).run(permission, Date.now(), existing.id);
      return { data: { id: existing.id, simulationId, userId, permission, created: false } };
    }

    const shareId = randomUUID();
    const now = Date.now();

    db.prepare(
      'INSERT INTO shared_simulations (id, simulation_id, owner_user_id, shared_with_user_id, permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(shareId, simulationId, ownerUserId, userId, permission, now, now);

    return { data: { id: shareId, simulationId, userId, permission, created: true } };
  });

  /* GET /api/v1/shared */
  app.get('/api/v1/shared', async (request) => {
    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const offset = (page - 1) * pageSize;

    const total = db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM shared_simulations WHERE shared_with_user_id = ?',
    ).get(userId)?.count ?? 0;

    const shares = db.prepare<SharedRow>(
      'SELECT id, simulation_id, owner_user_id, permission, created_at FROM shared_simulations WHERE shared_with_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(userId, pageSize, offset);

    return {
      data: shares.map((s: SharedRow) => ({
        id: s.id,
        simulationId: s.simulation_id,
        ownerUserId: s.owner_user_id,
        permission: s.permission,
        createdAt: new Date(s.created_at).toISOString(),
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  });

  /* DELETE /api/v1/simulations/:id/share/:userId */
  app.delete<{ Params: { id: string; userId: string } }>('/api/v1/simulations/:id/share/:userId', async (request, reply) => {
    const { id: simulationId, userId } = request.params;
    const ownerUserId = (request.user as { sub?: string })?.sub;

    if (!ownerUserId) {
      throw new AuthenticationError('需要登录', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const existing = db.prepare<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(simulationId, userId);

    if (!existing) {
      throw new NotFoundError('未找到对应的分享记录', ErrorCode.NOT_FOUND_VALUE);
    }
    if (existing.owner_user_id !== ownerUserId) {
      throw new AuthorizationError('无权限取消他人分享', ErrorCode.AUTH_INSUFFICIENT_ROLE);
    }

    db.prepare(
      'DELETE FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).run(simulationId, userId);

    return reply.status(204).send();
  });
}
