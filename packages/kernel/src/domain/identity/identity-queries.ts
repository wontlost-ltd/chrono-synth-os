/**
 * 身份管理 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const IDENT_QUERY_BY_USER = 'identity.byUser' as const;
export const IDENT_QUERY_BY_ID = 'identity.byId' as const;
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
  displayName?: string;
  bio?: string;
  now: number;
}

/* ── Query 工厂 ── */

export function identQueryByUser(userId: string): Query<IdentityRow | null, string> {
  return { kind: IDENT_QUERY_BY_USER, params: userId };
}

export function identQueryById(identityId: string): Query<IdentityRow | null, string> {
  return { kind: IDENT_QUERY_BY_ID, params: identityId };
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
