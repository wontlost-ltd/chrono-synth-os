/**
 * Collaboration Application Service
 * 封装模拟分享的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  collabQuerySimulationTenant, collabQueryExistingShare,
  collabQueryShareCount, collabQuerySharedList, collabQueryShareOwner,
  collabQuerySharesForSimulation,
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

/** 某模拟分享给了谁（owner 视角的一条记录）。 */
export interface SimulationShare {
  id: string;
  targetUserId: string;
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
    /* owner-only（安全修复）：只有模拟**真实创建者**（life_simulations.owner_user_id）能分享——堵住同租户
     * 非 owner 给别人的模拟抢注分享把自己变 owner。历史模拟 owner=null（无从证明归属）→ 保守拒绝（fail-closed），
     * 不放行任何人分享无主模拟。 */
    this.requireSimulationOwner(simulation.owner_user_id, ownerUserId);

    const existing = this.tx.queryOne(collabQueryExistingShare({ simulationId, targetUserId }));

    if (existing) {
      this.tx.execute(collabCmdUpdatePermission({ permission, now: Date.now(), shareId: existing.id }));
      return { id: existing.id, simulationId, userId: targetUserId, permission, created: false };
    }

    const shareId = randomUUID();
    const now = Date.now();
    this.tx.execute(collabCmdCreateShare({ id: shareId, simulationId, ownerUserId, targetUserId, permission, now }));
    return { id: shareId, simulationId, userId: targetUserId, permission, created: true };
  }

  /** owner-only 守卫：模拟真实 owner 必须匹配请求者。owner=null（历史无主）或不匹配 → 拒绝（fail-closed）。 */
  private requireSimulationOwner(simulationOwnerUserId: string | null, requesterUserId: string): void {
    if (simulationOwnerUserId === null || simulationOwnerUserId !== requesterUserId) {
      throw new AuthorizationError('无权限操作他人模拟的分享（仅模拟创建者可分享）', ErrorCode.AUTH_INSUFFICIENT_ROLE);
    }
  }

  listSharedWithUser(userId: string, page: number, pageSize: number): { data: SharedSimulation[]; total: number } {
    const offset = (page - 1) * pageSize;
    const countRow = this.tx.queryOne(collabQueryShareCount(userId));
    const total = countRow?.count ?? 0;

    const rows = this.tx.queryMany(collabQuerySharedList({ userId, limit: pageSize, offset }));

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

  /**
   * 列某模拟分享给了谁（owner 视角）。仅**模拟真实创建者**（life_simulations.owner_user_id）可见——
   * 在读分享记录**之前**就按真 owner 鉴权，故无分享时也能正确拒绝非 owner（堵住「无分享→空列表」的
   * 同租户存在性探测）。历史模拟 owner=null → 保守拒绝（fail-closed）。
   */
  listSharesForSimulation(simulationId: string, requesterUserId: string, tenantId: string): SimulationShare[] {
    const simulation = this.tx.queryOne(collabQuerySimulationTenant(simulationId));
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }
    this.requireSimulationOwner(simulation.owner_user_id, requesterUserId);
    const rows = this.tx.queryMany(collabQuerySharesForSimulation({ simulationId }));
    return rows.map((r) => ({
      id: r.id,
      targetUserId: r.shared_with_user_id,
      permission: r.permission,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  unshare(simulationId: string, targetUserId: string, ownerUserId: string, tenantId: string): void {
    const simulation = this.tx.queryOne(collabQuerySimulationTenant(simulationId));
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }
    /* owner-only（安全修复）：按模拟**真实创建者**校验（不再靠 shared 记录里的自封 owner）。 */
    this.requireSimulationOwner(simulation.owner_user_id, ownerUserId);

    const existing = this.tx.queryOne(collabQueryShareOwner({ simulationId, targetUserId }));
    if (!existing) {
      throw new NotFoundError('未找到对应的分享记录', ErrorCode.NOT_FOUND_VALUE);
    }

    this.tx.execute(collabCmdDeleteShare({ simulationId, targetUserId }));
  }
}
