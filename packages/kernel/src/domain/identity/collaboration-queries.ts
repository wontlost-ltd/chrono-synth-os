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

/* ── Command Kinds ── */

export const COLLAB_CMD_UPDATE_PERMISSION = 'collab.updatePermission' as const;
export const COLLAB_CMD_CREATE_SHARE = 'collab.createShare' as const;
export const COLLAB_CMD_DELETE_SHARE = 'collab.deleteShare' as const;

/* ── 行类型 ── */

export interface CollabSimTenantRow {
  readonly tenant_id: string;
}

export interface CollabExistingShareRow {
  readonly id: string;
  readonly owner_user_id: string;
}

export interface CollabShareCountRow {
  readonly count: number;
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

/* ── 参数类型 ── */

export interface CollabExistingShareParams {
  simulationId: string;
  targetUserId: string;
}

export interface CollabSharedListParams {
  userId: string;
  limit: number;
  offset: number;
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

export function collabQueryShareCount(userId: string): Query<CollabShareCountRow | null, string> {
  return { kind: COLLAB_QUERY_SHARE_COUNT, params: userId };
}

export function collabQuerySharedList(params: CollabSharedListParams): Query<CollabSharedRow, CollabSharedListParams> {
  return { kind: COLLAB_QUERY_SHARED_LIST, params };
}

export function collabQueryShareOwner(params: CollabExistingShareParams): Query<CollabShareOwnerRow | null, CollabExistingShareParams> {
  return { kind: COLLAB_QUERY_SHARE_OWNER, params };
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
