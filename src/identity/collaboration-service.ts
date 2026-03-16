/**
 * Collaboration Application Service
 * 封装模拟分享的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { AuthorizationError, NotFoundError, ErrorCode } from '../errors/index.js';

interface SharedRow {
  id: string;
  simulation_id: string;
  owner_user_id: string;
  shared_with_user_id: string;
  permission: string;
  created_at: number;
}

export interface ShareResult {
  id: string;
  simulationId: string;
  userId: string;
  permission: string;
  created: boolean;
}

export interface SharedSimulation {
  id: string;
  simulationId: string;
  ownerUserId: string;
  permission: string;
  createdAt: string;
}

export class CollaborationService {
  constructor(private readonly db: IDatabase) {}

  share(simulationId: string, ownerUserId: string, tenantId: string, targetUserId: string, permission: string): ShareResult {
    const simulation = this.db.prepare<{ tenant_id: string }>(
      'SELECT tenant_id FROM life_simulations WHERE id = ?',
    ).get(simulationId);
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }

    const existing = this.db.prepare<{ id: string; owner_user_id: string }>(
      'SELECT id, owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(simulationId, targetUserId);

    if (existing) {
      if (existing.owner_user_id !== ownerUserId) {
        throw new AuthorizationError('无权限修改他人分享', ErrorCode.AUTH_INSUFFICIENT_ROLE);
      }
      this.db.prepare<void>(
        'UPDATE shared_simulations SET permission = ?, updated_at = ? WHERE id = ?',
      ).run(permission, Date.now(), existing.id);
      return { id: existing.id, simulationId, userId: targetUserId, permission, created: false };
    }

    const shareId = randomUUID();
    const now = Date.now();
    this.db.prepare<void>(
      'INSERT INTO shared_simulations (id, simulation_id, owner_user_id, shared_with_user_id, permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(shareId, simulationId, ownerUserId, targetUserId, permission, now, now);
    return { id: shareId, simulationId, userId: targetUserId, permission, created: true };
  }

  listSharedWithUser(userId: string, page: number, pageSize: number): { data: SharedSimulation[]; total: number } {
    const offset = (page - 1) * pageSize;
    const total = this.db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM shared_simulations WHERE shared_with_user_id = ?',
    ).get(userId)?.count ?? 0;

    const rows = this.db.prepare<SharedRow>(
      'SELECT id, simulation_id, owner_user_id, permission, created_at FROM shared_simulations WHERE shared_with_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(userId, pageSize, offset);

    return {
      data: rows.map((s) => ({
        id: s.id,
        simulationId: s.simulation_id,
        ownerUserId: s.owner_user_id,
        permission: s.permission,
        createdAt: new Date(s.created_at).toISOString(),
      })),
      total,
    };
  }

  unshare(simulationId: string, targetUserId: string, ownerUserId: string): void {
    const existing = this.db.prepare<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).get(simulationId, targetUserId);

    if (!existing) {
      throw new NotFoundError('未找到对应的分享记录', ErrorCode.NOT_FOUND_VALUE);
    }
    if (existing.owner_user_id !== ownerUserId) {
      throw new AuthorizationError('无权限取消他人分享', ErrorCode.AUTH_INSUFFICIENT_ROLE);
    }

    this.db.prepare<void>(
      'DELETE FROM shared_simulations WHERE simulation_id = ? AND shared_with_user_id = ?',
    ).run(simulationId, targetUserId);
  }
}
