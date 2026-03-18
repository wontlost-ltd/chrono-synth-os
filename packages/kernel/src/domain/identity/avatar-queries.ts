/**
 * 分身管理 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const AVT_QUERY_BY_ID = 'avatar.byId' as const;
export const AVT_QUERY_BY_ID_IDENTITY = 'avatar.byIdIdentity' as const;
export const AVT_QUERY_BY_IDENTITY = 'avatar.byIdentity' as const;
export const AVT_QUERY_DEFAULT = 'avatar.default' as const;
export const AVT_QUERY_COUNT_ACTIVE = 'avatar.countActive' as const;

/* ── Command Kinds ── */

export const AVT_CMD_CREATE = 'avatar.create' as const;
export const AVT_CMD_UPDATE = 'avatar.update' as const;
export const AVT_CMD_UPDATE_FOR_IDENTITY = 'avatar.updateForIdentity' as const;
export const AVT_CMD_SOFT_DELETE = 'avatar.softDelete' as const;
export const AVT_CMD_SOFT_DELETE_FOR_IDENTITY = 'avatar.softDeleteForIdentity' as const;

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
