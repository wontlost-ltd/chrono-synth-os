/**
 * 身份管理 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

/** 按 (tenant_id, user_id) 查身份——分片双重约束的租户 predicate（Plan 1b）。 */
export const IDENT_QUERY_BY_TENANT_AND_USER = 'identity.byTenantAndUser' as const;
/** 按 (tenant_id, id) 查身份——update 后回读须带 tenant predicate。 */
export const IDENT_QUERY_BY_TENANT_AND_ID = 'identity.byTenantAndId' as const;
export const IDENT_QUERY_BY_TENANT = 'identity.byTenant' as const;

/* ── Command Kinds ── */

export const IDENT_CMD_CREATE = 'identity.create' as const;
export const IDENT_CMD_CREATE_DEFAULT_AVATAR = 'identity.createDefaultAvatar' as const;
export const IDENT_CMD_UPDATE = 'identity.update' as const;

/* ── 行类型 ── */

export interface IdentityRow {
  readonly id: string;
  readonly user_id: string;
  readonly tenant_id: string;
  readonly display_name: string;
  readonly bio: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── 参数类型 ── */

export interface IdentCreateParams {
  identityId: string;
  userId: string;
  tenantId: string;
  displayName: string;
  now: number;
}

export interface IdentCreateDefaultAvatarParams {
  avatarId: string;
  identityId: string;
  now: number;
}

export interface IdentUpdateParams {
  identityId: string;
  /** 租户约束：UPDATE 固定 `WHERE id=? AND tenant_id=?`（identities 有 tenant_id 列，非 EXISTS）。 */
  tenantId: string;
  displayName?: string;
  bio?: string;
  now: number;
}

/** 按 (tenant_id, user_id) 查身份的参数。 */
export interface IdentByTenantAndUserParams {
  tenantId: string;
  userId: string;
}

/** 按 (tenant_id, id) 查身份的参数。 */
export interface IdentByTenantAndIdParams {
  tenantId: string;
  identityId: string;
}

/* ── Query 工厂 ── */

export function identQueryByTenantAndUser(tenantId: string, userId: string): Query<IdentityRow | null, IdentByTenantAndUserParams> {
  return { kind: IDENT_QUERY_BY_TENANT_AND_USER, params: { tenantId, userId } };
}

export function identQueryByTenantAndId(tenantId: string, identityId: string): Query<IdentityRow | null, IdentByTenantAndIdParams> {
  return { kind: IDENT_QUERY_BY_TENANT_AND_ID, params: { tenantId, identityId } };
}

export function identQueryByTenant(tenantId: string): Query<IdentityRow, string> {
  return { kind: IDENT_QUERY_BY_TENANT, params: tenantId };
}

/* ── Command 工厂 ── */

export function identCmdCreate(params: IdentCreateParams): Command<IdentCreateParams> {
  return { kind: IDENT_CMD_CREATE, params };
}

export function identCmdCreateDefaultAvatar(params: IdentCreateDefaultAvatarParams): Command<IdentCreateDefaultAvatarParams> {
  return { kind: IDENT_CMD_CREATE_DEFAULT_AVATAR, params };
}

export function identCmdUpdate(params: IdentUpdateParams): Command<IdentUpdateParams> {
  return { kind: IDENT_CMD_UPDATE, params };
}
