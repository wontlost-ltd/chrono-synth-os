/**
 * Collaboration Application Service
 * 封装模拟分享的数据访问与业务逻辑
 *
 * 分片 Phase 0 · Plan 1b（Task 4 Collaboration 组）：
 * - `shared_simulations` 表**无 tenant_id 列**（只 simulation_id/owner_user_id/shared_with_user_id）→
 *   租户约束全经 `life_simulations` 父归属：
 *   · share/listSharesForSimulation/unshare 均先查 `collabQuerySimulationTenant`（读 life_simulations.tenant_id）
 *     并在服务层校验 `simulation.tenant_id === tenantId`——这就是父归属 tenant predicate（不匹配即 NotFound）。
 *   · listSharedWithUser 无 simulationId 入口 → count/list 查询在 SQL 层 `JOIN life_simulations WHERE ls.tenant_id=?`。
 * - ctor 收 `TenantDbResolver`；`txFor(tenantId)` 每次 `dbForTenant(tenantId)` 现取该租户 shard 的 tx（不缓存）。
 *   照 MobileDeviceService 直取模式（shared_simulations 不被 mixed-scope coordinator 复用，不抽 writer seam）。
 * - 双重约束：`dbForTenant(tenantId)` 选对 shard + 父归属 predicate 防同库跨租户读改删。
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  collabQuerySimulationTenant, collabQueryExistingShare,
  collabQueryShareCount, collabQuerySharedList, collabQueryShareOwner,
  collabQuerySharesForSimulation,
  collabCmdUpdatePermission, collabCmdCreateShare, collabCmdDeleteShare,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
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
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现取该租户 shard 的 tx（dbForTenant 选 shard），不跨请求缓存。 */
  private txFor(tenantId: string): SyncWriteUnitOfWork {
    return this.resolver.dbForTenant(tenantId);
  }

  share(simulationId: string, ownerUserId: string, tenantId: string, targetUserId: string, permission: string): ShareResult {
    const tx = this.txFor(tenantId);
    const simulation = tx.queryOne(collabQuerySimulationTenant(simulationId));
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }
    /* owner-only（安全修复）：只有模拟**真实创建者**（life_simulations.owner_user_id）能分享——堵住同租户
     * 非 owner 给别人的模拟抢注分享把自己变 owner。历史模拟 owner=null（无从证明归属）→ 保守拒绝（fail-closed），
     * 不放行任何人分享无主模拟。 */
    this.requireSimulationOwner(simulation.owner_user_id, ownerUserId);

    const existing = tx.queryOne(collabQueryExistingShare({ simulationId, targetUserId }));

    if (existing) {
      tx.execute(collabCmdUpdatePermission({ permission, now: Date.now(), shareId: existing.id }));
      return { id: existing.id, simulationId, userId: targetUserId, permission, created: false };
    }

    const shareId = randomUUID();
    const now = Date.now();
    tx.execute(collabCmdCreateShare({ id: shareId, simulationId, ownerUserId, targetUserId, permission, now }));
    return { id: shareId, simulationId, userId: targetUserId, permission, created: true };
  }

  /** owner-only 守卫：模拟真实 owner 必须匹配请求者。owner=null（历史无主）或不匹配 → 拒绝（fail-closed）。 */
  private requireSimulationOwner(simulationOwnerUserId: string | null, requesterUserId: string): void {
    if (simulationOwnerUserId === null || simulationOwnerUserId !== requesterUserId) {
      throw new AuthorizationError('无权限操作他人模拟的分享（仅模拟创建者可分享）', ErrorCode.AUTH_INSUFFICIENT_ROLE);
    }
  }

  /**
   * 列分享给某用户的模拟（被分享者视角）。shared_simulations 无 tenant_id 列 →
   * count/list 查询在 SQL 层 `JOIN life_simulations WHERE ls.tenant_id=?` 做父归属 tenant predicate：
   * 双重约束 = `dbForTenant(tenantId)` 选对 shard + JOIN 父归属防同库跨租户读到别租户的 share。
   */
  listSharedWithUser(tenantId: string, userId: string, page: number, pageSize: number): { data: SharedSimulation[]; total: number } {
    const tx = this.txFor(tenantId);
    const offset = (page - 1) * pageSize;
    const countRow = tx.queryOne(collabQueryShareCount({ tenantId, userId }));
    const total = countRow?.count ?? 0;

    const rows = tx.queryMany(collabQuerySharedList({ tenantId, userId, limit: pageSize, offset }));

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
    const tx = this.txFor(tenantId);
    const simulation = tx.queryOne(collabQuerySimulationTenant(simulationId));
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }
    this.requireSimulationOwner(simulation.owner_user_id, requesterUserId);
    const rows = tx.queryMany(collabQuerySharesForSimulation({ simulationId }));
    return rows.map((r) => ({
      id: r.id,
      targetUserId: r.shared_with_user_id,
      permission: r.permission,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  unshare(simulationId: string, targetUserId: string, ownerUserId: string, tenantId: string): void {
    const tx = this.txFor(tenantId);
    const simulation = tx.queryOne(collabQuerySimulationTenant(simulationId));
    if (!simulation || simulation.tenant_id !== tenantId) {
      throw new NotFoundError('模拟不存在', ErrorCode.NOT_FOUND_VALUE);
    }
    /* owner-only（安全修复）：按模拟**真实创建者**校验（不再靠 shared 记录里的自封 owner）。 */
    this.requireSimulationOwner(simulation.owner_user_id, ownerUserId);

    const existing = tx.queryOne(collabQueryShareOwner({ simulationId, targetUserId }));
    if (!existing) {
      throw new NotFoundError('未找到对应的分享记录', ErrorCode.NOT_FOUND_VALUE);
    }

    tx.execute(collabCmdDeleteShare({ simulationId, targetUserId }));
  }
}
