/**
 * 协作服务 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const COLLAB_QUERY_SIMULATION_TENANT = 'collab.simulationTenant' as const;
export const COLLAB_QUERY_EXISTING_SHARE = 'collab.existingShare' as const;
export const COLLAB_QUERY_SHARE_COUNT = 'collab.shareCount' as const;
export const COLLAB_QUERY_SHARED_LIST = 'collab.sharedList' as const;
export const COLLAB_QUERY_SHARE_OWNER = 'collab.shareOwner' as const;
export const COLLAB_QUERY_SHARES_FOR_SIMULATION = 'collab.sharesForSimulation' as const;

/* ── Command Kinds ── */

export const COLLAB_CMD_UPDATE_PERMISSION = 'collab.updatePermission' as const;
export const COLLAB_CMD_CREATE_SHARE = 'collab.createShare' as const;
export const COLLAB_CMD_DELETE_SHARE = 'collab.deleteShare' as const;

/* ── 行类型 ── */

export interface CollabSimTenantRow {
  readonly tenant_id: string;
  /** 模拟创建者（owner-only 分享鉴权的真实来源）；历史模拟无 owner → null。 */
  readonly owner_user_id: string | null;
}

export interface CollabExistingShareRow {
  readonly id: string;
  readonly owner_user_id: string;
}

export interface CollabShareCountRow {
  readonly count: number;
}

/** listSharedWithUser 的 count/list 参数：shared_simulations 无 tenant_id 列，
 *  故经 life_simulations 父归属（JOIN ... WHERE ls.tenant_id=?）做 tenant predicate。 */
export interface CollabShareCountParams {
  tenantId: string;
  userId: string;
}

export interface CollabSharedRow {
  readonly id: string;
  readonly simulation_id: string;
  readonly owner_user_id: string;
  readonly permission: string;
  readonly created_at: number;
}

export interface CollabShareOwnerRow {
  readonly owner_user_id: string;
}

/** 某模拟的一条分享记录（列「分享给了谁」用；owner 视角）。 */
export interface CollabShareForSimulationRow {
  readonly id: string;
  readonly shared_with_user_id: string;
  readonly permission: string;
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface CollabExistingShareParams {
  simulationId: string;
  targetUserId: string;
}

export interface CollabSharedListParams {
  tenantId: string;
  userId: string;
  limit: number;
  offset: number;
}

/** 列某模拟分享给了谁（owner 视角，按 simulationId）。 */
export interface CollabSharesForSimulationParams {
  simulationId: string;
}

export interface CollabUpdatePermissionParams {
  shareId: string;
  permission: string;
  now: number;
}

export interface CollabCreateShareParams {
  id: string;
  simulationId: string;
  ownerUserId: string;
  targetUserId: string;
  permission: string;
  now: number;
}

export interface CollabDeleteShareParams {
  simulationId: string;
  targetUserId: string;
}

/* ── Query 工厂 ── */

export function collabQuerySimulationTenant(simulationId: string): Query<CollabSimTenantRow | null, string> {
  return { kind: COLLAB_QUERY_SIMULATION_TENANT, params: simulationId };
}

export function collabQueryExistingShare(params: CollabExistingShareParams): Query<CollabExistingShareRow | null, CollabExistingShareParams> {
  return { kind: COLLAB_QUERY_EXISTING_SHARE, params };
}

export function collabQueryShareCount(params: CollabShareCountParams): Query<CollabShareCountRow | null, CollabShareCountParams> {
  return { kind: COLLAB_QUERY_SHARE_COUNT, params };
}

export function collabQuerySharedList(params: CollabSharedListParams): Query<CollabSharedRow, CollabSharedListParams> {
  return { kind: COLLAB_QUERY_SHARED_LIST, params };
}

export function collabQueryShareOwner(params: CollabExistingShareParams): Query<CollabShareOwnerRow | null, CollabExistingShareParams> {
  return { kind: COLLAB_QUERY_SHARE_OWNER, params };
}

export function collabQuerySharesForSimulation(params: CollabSharesForSimulationParams): Query<CollabShareForSimulationRow, CollabSharesForSimulationParams> {
  return { kind: COLLAB_QUERY_SHARES_FOR_SIMULATION, params };
}

/* ── Command 工厂 ── */

export function collabCmdUpdatePermission(params: CollabUpdatePermissionParams): Command<CollabUpdatePermissionParams> {
  return { kind: COLLAB_CMD_UPDATE_PERMISSION, params };
}

export function collabCmdCreateShare(params: CollabCreateShareParams): Command<CollabCreateShareParams> {
  return { kind: COLLAB_CMD_CREATE_SHARE, params };
}

export function collabCmdDeleteShare(params: CollabDeleteShareParams): Command<CollabDeleteShareParams> {
  return { kind: COLLAB_CMD_DELETE_SHARE, params };
}
