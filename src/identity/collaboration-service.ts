/**
 * Collaboration Application Service
 * 封装模拟分享的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  collabQuerySimulationTenant, collabQueryExistingShare,
  collabQueryShareCount, collabQuerySharedList, collabQueryShareOwner,
  collabCmdUpdatePermission, collabCmdCreateShare, collabCmdDeleteShare,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { AuthorizationError, NotFoundError, ErrorCode } from '../errors/index.js';

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
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  share(simulationId: string, ownerUserId: string, tenantId: string, targetUserId: string, permission: string): ShareResult {
    const simulation = this.tx.queryOne(collabQuerySimulationTenant(simulationId));
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }

    const existing = this.tx.queryOne(collabQueryExistingShare({ simulationId, targetUserId }));

    if (existing) {
      if (existing.owner_user_id !== ownerUserId) {
        throw new AuthorizationError('无权限修改他人分享', ErrorCode.AUTH_INSUFFICIENT_ROLE);
      }
      this.tx.execute(collabCmdUpdatePermission({ permission, now: Date.now(), shareId: existing.id }));
      return { id: existing.id, simulationId, userId: targetUserId, permission, created: false };
    }

    const shareId = randomUUID();
    const now = Date.now();
    this.tx.execute(collabCmdCreateShare({ id: shareId, simulationId, ownerUserId, targetUserId, permission, now }));
    return { id: shareId, simulationId, userId: targetUserId, permission, created: true };
  }

  listSharedWithUser(userId: string, page: number, pageSize: number): { data: SharedSimulation[]; total: number } {
    const offset = (page - 1) * pageSize;
    const countRow = this.tx.queryOne(collabQueryShareCount(userId));
    const total = countRow?.count ?? 0;

    const rows = this.tx.queryMany(collabQuerySharedList({ userId, limit: pageSize, offset })) as unknown as import('@chrono/kernel').CollabSharedRow[];

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
    const existing = this.tx.queryOne(collabQueryShareOwner({ simulationId, targetUserId }));

    if (!existing) {
      throw new NotFoundError('未找到对应的分享记录', ErrorCode.NOT_FOUND_VALUE);
    }
    if (existing.owner_user_id !== ownerUserId) {
      throw new AuthorizationError('无权限取消他人分享', ErrorCode.AUTH_INSUFFICIENT_ROLE);
    }

    this.tx.execute(collabCmdDeleteShare({ simulationId, targetUserId }));
  }
}
