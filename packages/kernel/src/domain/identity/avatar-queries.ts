/**
 * 分身管理 Query/Command kind 常量与参数类型
 *
 * 分片 Phase 0 · Plan 1b（Task 2 Avatar 组）：
 * avatars **无 tenant_id 列**（只 identity_id，v027）→ 租户归属经父表 identities。
 * 因此 tenant-scoped 变体全部 `JOIN identities i ON i.id = a.identity_id WHERE i.tenant_id = ?`
 * （读）或 `WHERE identity_id IN (SELECT id FROM identities WHERE tenant_id = ?)`（写），
 * create 前先 `EXISTS identities WHERE id=? AND tenant_id=?` 验父归属（防跨租户在别人 identity 下建 avatar）。
 * 无 tenantId 的旧变体保留供 Plan 1c 定位 tenant 后的内部路径复用（本 Plan tenant-scoped 路径只用 *ForTenant）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const AVT_QUERY_BY_ID = 'avatar.byId' as const;
export const AVT_QUERY_BY_ID_IDENTITY = 'avatar.byIdIdentity' as const;
export const AVT_QUERY_BY_IDENTITY = 'avatar.byIdentity' as const;
export const AVT_QUERY_DEFAULT = 'avatar.default' as const;
export const AVT_QUERY_COUNT_ACTIVE = 'avatar.countActive' as const;

/* ── tenant-scoped Query Kinds（父归属 JOIN identities，Plan 1b Task 2）── */

export const AVT_QUERY_BY_ID_FOR_TENANT = 'avatar.byIdForTenant' as const;
export const AVT_QUERY_BY_ID_IDENTITY_FOR_TENANT = 'avatar.byIdIdentityForTenant' as const;
export const AVT_QUERY_BY_IDENTITY_FOR_TENANT = 'avatar.byIdentityForTenant' as const;
export const AVT_QUERY_DEFAULT_FOR_TENANT = 'avatar.defaultForTenant' as const;
export const AVT_QUERY_COUNT_ACTIVE_FOR_TENANT = 'avatar.countActiveForTenant' as const;
/** 父归属探针：identity 是否属于该租户（create 前置校验 + DeviceAvatar avatar 端验）。 */
export const AVT_QUERY_IDENTITY_BELONGS_TO_TENANT = 'avatar.identityBelongsToTenant' as const;

/* ── Command Kinds ── */

export const AVT_CMD_CREATE = 'avatar.create' as const;
export const AVT_CMD_UPDATE = 'avatar.update' as const;
export const AVT_CMD_UPDATE_FOR_IDENTITY = 'avatar.updateForIdentity' as const;
export const AVT_CMD_SOFT_DELETE = 'avatar.softDelete' as const;
export const AVT_CMD_SOFT_DELETE_FOR_IDENTITY = 'avatar.softDeleteForIdentity' as const;

/* ── tenant-scoped Command Kinds（父归属子查询，Plan 1b Task 2）── */

export const AVT_CMD_UPDATE_FOR_TENANT = 'avatar.updateForTenant' as const;
export const AVT_CMD_SOFT_DELETE_FOR_TENANT = 'avatar.softDeleteForTenant' as const;

/* ── 行类型 ── */

export interface AvatarRow {
  readonly id: string;
  readonly identity_id: string;
  readonly label: string;
  readonly kind: string;
  readonly behavior_overrides: string | null;
  readonly is_default: number;
  readonly is_active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── 参数类型 ── */

export interface AvtCreateParams {
  id: string;
  identityId: string;
  label: string;
  kind: string;
  behaviorOverrides: string | null;
  now: number;
}

export interface AvtUpdateParams {
  avatarId: string;
  label?: string;
  kind?: string;
  behaviorOverrides?: string;
  now: number;
}

export interface AvtUpdateForIdentityParams {
  avatarId: string;
  identityId: string;
  label?: string;
  kind?: string;
  behaviorOverrides?: string;
  now: number;
}

export interface AvtSoftDeleteParams {
  avatarId: string;
  now: number;
}

export interface AvtSoftDeleteForIdentityParams {
  avatarId: string;
  identityId: string;
  now: number;
}

export interface AvtByIdIdentityParams {
  avatarId: string;
  identityId: string;
}

/* ── tenant-scoped 参数类型（父归属，Plan 1b Task 2）── */

export interface AvtByIdForTenantParams {
  tenantId: string;
  avatarId: string;
}

export interface AvtByIdIdentityForTenantParams {
  tenantId: string;
  avatarId: string;
  identityId: string;
}

export interface AvtByIdentityForTenantParams {
  tenantId: string;
  identityId: string;
}

export interface AvtIdentityBelongsToTenantParams {
  tenantId: string;
  identityId: string;
}

export interface AvtUpdateForTenantParams {
  tenantId: string;
  avatarId: string;
  label?: string;
  kind?: string;
  behaviorOverrides?: string;
  now: number;
}

export interface AvtSoftDeleteForTenantParams {
  tenantId: string;
  avatarId: string;
  now: number;
}

/* ── Query 工厂 ── */

export function avtQueryById(avatarId: string): Query<AvatarRow | null, string> {
  return { kind: AVT_QUERY_BY_ID, params: avatarId };
}

export function avtQueryByIdIdentity(avatarId: string, identityId: string): Query<AvatarRow | null, AvtByIdIdentityParams> {
  return { kind: AVT_QUERY_BY_ID_IDENTITY, params: { avatarId, identityId } };
}

export function avtQueryByIdentity(identityId: string): Query<AvatarRow, string> {
  return { kind: AVT_QUERY_BY_IDENTITY, params: identityId };
}

export function avtQueryDefault(identityId: string): Query<AvatarRow | null, string> {
  return { kind: AVT_QUERY_DEFAULT, params: identityId };
}

export function avtQueryCountActive(identityId: string): Query<{ count: number } | null, string> {
  return { kind: AVT_QUERY_COUNT_ACTIVE, params: identityId };
}

/* ── Command 工厂 ── */

export function avtCmdCreate(params: AvtCreateParams): Command<AvtCreateParams> {
  return { kind: AVT_CMD_CREATE, params };
}

export function avtCmdUpdate(params: AvtUpdateParams): Command<AvtUpdateParams> {
  return { kind: AVT_CMD_UPDATE, params };
}

export function avtCmdUpdateForIdentity(params: AvtUpdateForIdentityParams): Command<AvtUpdateForIdentityParams> {
  return { kind: AVT_CMD_UPDATE_FOR_IDENTITY, params };
}

export function avtCmdSoftDelete(params: AvtSoftDeleteParams): Command<AvtSoftDeleteParams> {
  return { kind: AVT_CMD_SOFT_DELETE, params };
}

export function avtCmdSoftDeleteForIdentity(params: AvtSoftDeleteForIdentityParams): Command<AvtSoftDeleteForIdentityParams> {
  return { kind: AVT_CMD_SOFT_DELETE_FOR_IDENTITY, params };
}

/* ── tenant-scoped Query/Command 工厂（父归属，Plan 1b Task 2）── */

export function avtQueryByIdForTenant(tenantId: string, avatarId: string): Query<AvatarRow | null, AvtByIdForTenantParams> {
  return { kind: AVT_QUERY_BY_ID_FOR_TENANT, params: { tenantId, avatarId } };
}

export function avtQueryByIdIdentityForTenant(tenantId: string, avatarId: string, identityId: string): Query<AvatarRow | null, AvtByIdIdentityForTenantParams> {
  return { kind: AVT_QUERY_BY_ID_IDENTITY_FOR_TENANT, params: { tenantId, avatarId, identityId } };
}

export function avtQueryByIdentityForTenant(tenantId: string, identityId: string): Query<AvatarRow, AvtByIdentityForTenantParams> {
  return { kind: AVT_QUERY_BY_IDENTITY_FOR_TENANT, params: { tenantId, identityId } };
}

export function avtQueryDefaultForTenant(tenantId: string, identityId: string): Query<AvatarRow | null, AvtByIdentityForTenantParams> {
  return { kind: AVT_QUERY_DEFAULT_FOR_TENANT, params: { tenantId, identityId } };
}

export function avtQueryCountActiveForTenant(tenantId: string, identityId: string): Query<{ count: number } | null, AvtByIdentityForTenantParams> {
  return { kind: AVT_QUERY_COUNT_ACTIVE_FOR_TENANT, params: { tenantId, identityId } };
}

export function avtQueryIdentityBelongsToTenant(tenantId: string, identityId: string): Query<{ id: string } | null, AvtIdentityBelongsToTenantParams> {
  return { kind: AVT_QUERY_IDENTITY_BELONGS_TO_TENANT, params: { tenantId, identityId } };
}

export function avtCmdUpdateForTenant(params: AvtUpdateForTenantParams): Command<AvtUpdateForTenantParams> {
  return { kind: AVT_CMD_UPDATE_FOR_TENANT, params };
}

export function avtCmdSoftDeleteForTenant(params: AvtSoftDeleteForTenantParams): Command<AvtSoftDeleteForTenantParams> {
  return { kind: AVT_CMD_SOFT_DELETE_FOR_TENANT, params };
}
