/**
 * 协作路由
 * POST   /api/v1/simulations/:id/share          — 分享模拟给其他用户
 * GET    /api/v1/shared                           — 获取分享给我的模拟列表
 * DELETE /api/v1/simulations/:id/share/:userId    — 取消分享
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';

interface ShareBody {
  userId: string;
  permission: 'view' | 'edit';
}

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
  app.post('/api/v1/simulations/:id/share', async (request, reply) => {
    const { id: simulationId } = request.params as { id: string };
    const ownerUserId = (request.user as { sub?: string })?.sub;
    const tenantId = (request as { tenantId?: string }).tenantId ?? 'default';

    if (!ownerUserId) {
      return reply.status(401).send({ error: 'AuthenticationError', message: '需要登录' });
    }

    const { userId, permission } = request.body as ShareBody;

    if (!userId || !permission) {
      return reply.status(400).send({ error: 'ValidationError', message: '必须提供 userId 和 permission' });
    }

    if (!['view', 'edit'].includes(permission)) {
      return reply.status(400).send({ error: 'ValidationError', message: 'permission 必须为 view 或 edit' });
    }

    /* 验证模拟归属当前租户 */
    const simulation = db.prepare<{ tenant_id: string }>(
      'SELECT tenant_id FROM life_simulations WHERE id = ?',
    ).get(simulationId);
    if (!simulation || simulation.tenant_id !== tenantId) {
      return reply.status(404).send({ error: 'NotFound', message: '模拟不存在' });
    }

    const existing = db.prepare<{ id: string; owner_user_id: string }>(
      'SELECT id, owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(simulationId, userId);

    if (existing) {
      if (existing.owner_user_id !== ownerUserId) {
        return reply.status(403).send({ error: 'AuthorizationError', message: '无权限修改他人分享' });
      }
      db.prepare(
        'UPDATE shared_simulations SET permission = ?, updated_at = ? WHERE id = ?',
      ).run(permission, Date.now(), existing.id);
      return reply.status(200).send({ id: existing.id, simulationId, userId, permission, updated: true });
    }

    const shareId = randomUUID();
    const now = Date.now();

    db.prepare(
      'INSERT INTO shared_simulations (id, simulation_id, owner_user_id, shared_with_user_id, permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(shareId, simulationId, ownerUserId, userId, permission, now, now);

    return reply.status(201).send({ id: shareId, simulationId, userId, permission });
  });

  /* GET /api/v1/shared */
  app.get('/api/v1/shared', async (request, reply) => {
    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) {
      return reply.status(401).send({ error: 'AuthenticationError', message: '需要登录' });
    }

    const shares = db.prepare<SharedRow>(
      'SELECT id, simulation_id, owner_user_id, permission, created_at FROM shared_simulations WHERE shared_with_user_id = ? ORDER BY created_at DESC',
    ).all(userId);

    return shares.map((s: SharedRow) => ({
      id: s.id,
      simulationId: s.simulation_id,
      ownerUserId: s.owner_user_id,
      permission: s.permission,
      createdAt: new Date(s.created_at).toISOString(),
    }));
  });

  /* DELETE /api/v1/simulations/:id/share/:userId */
  app.delete('/api/v1/simulations/:id/share/:userId', async (request, reply) => {
    const { id: simulationId, userId } = request.params as { id: string; userId: string };
    const ownerUserId = (request.user as { sub?: string })?.sub;

    if (!ownerUserId) {
      return reply.status(401).send({ error: 'AuthenticationError', message: '需要登录' });
    }

    const existing = db.prepare<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(simulationId, userId);

    if (!existing) {
      return reply.status(404).send({ error: 'NotFound', message: '未找到对应的分享记录' });
    }
    if (existing.owner_user_id !== ownerUserId) {
      return reply.status(403).send({ error: 'AuthorizationError', message: '无权限取消他人分享' });
    }

    db.prepare(
      'DELETE FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).run(simulationId, userId);

    return reply.status(204).send();
  });
}
