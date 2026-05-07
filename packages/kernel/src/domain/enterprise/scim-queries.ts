/**
 * SCIM Provisioning Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const SCIM_QUERY_USERS = 'scim.users' as const;
export const SCIM_QUERY_USERS_BY_EMAIL = 'scim.usersByEmail' as const;
export const SCIM_QUERY_USER_COUNT = 'scim.userCount' as const;
export const SCIM_QUERY_USER_COUNT_BY_EMAIL = 'scim.userCountByEmail' as const;
export const SCIM_QUERY_USER_BY_EMAIL_GLOBAL = 'scim.userByEmailGlobal' as const;
export const SCIM_QUERY_USER_BY_ID = 'scim.userById' as const;
export const SCIM_QUERY_USER_EXISTS = 'scim.userExists' as const;
export const SCIM_QUERY_AVATAR_IDS_BY_USER = 'scim.avatarIdsByUser' as const;

/* ── Command Kinds ── */

export const SCIM_CMD_CREATE_USER = 'scim.createUser' as const;
export const SCIM_CMD_DELETE_DEVICE_AVATARS = 'scim.deleteDeviceAvatars' as const;
export const SCIM_CMD_DELETE_AUTORUN_RUNLOG = 'scim.deleteAutorunRunlog' as const;
export const SCIM_CMD_DELETE_AUTORUN_CONFIG = 'scim.deleteAutorunConfig' as const;
export const SCIM_CMD_DELETE_AVATARS_BY_IDENTITY = 'scim.deleteAvatarsByIdentity' as const;
export const SCIM_CMD_DELETE_REFRESH_TOKENS = 'scim.deleteRefreshTokens' as const;
export const SCIM_CMD_DELETE_IDENTITIES = 'scim.deleteIdentities' as const;
export const SCIM_CMD_DELETE_USER = 'scim.deleteUser' as const;

/* ── 行类型 ── */

export interface ScimUserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: string;
  readonly tenant_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ScimUserCountRow {
  readonly count: number;
}

export interface ScimUserBriefRow {
  readonly id: string;
  readonly tenant_id: string;
}

export interface ScimAvatarIdRow {
  readonly id: string;
}

/* ── 参数类型 ── */

export interface ScimUsersParams {
  tenantId: string;
  count: number;
  offset: number;
}

export interface ScimUsersByEmailParams {
  tenantId: string;
  email: string;
  count: number;
  offset: number;
}

export interface ScimTenantEmailParams {
  tenantId: string;
  email: string;
}

export interface ScimTenantIdParams {
  tenantId: string;
  userId: string;
}

export interface ScimCreateUserParams {
  id: string;
  email: string;
  tenantId: string;
  now: number;
}

export interface ScimDeleteUserParams {
  userId: string;
  tenantId: string;
}

/* ── Query 工厂 ── */

export function scimQueryUsers(params: ScimUsersParams): Query<ScimUserRow, ScimUsersParams> {
  return { kind: SCIM_QUERY_USERS, params };
}

export function scimQueryUsersByEmail(params: ScimUsersByEmailParams): Query<ScimUserRow, ScimUsersByEmailParams> {
  return { kind: SCIM_QUERY_USERS_BY_EMAIL, params };
}

export function scimQueryUserCount(tenantId: string): Query<ScimUserCountRow | null, string> {
  return { kind: SCIM_QUERY_USER_COUNT, params: tenantId };
}

export function scimQueryUserCountByEmail(params: ScimTenantEmailParams): Query<ScimUserCountRow | null, ScimTenantEmailParams> {
  return { kind: SCIM_QUERY_USER_COUNT_BY_EMAIL, params };
}

export function scimQueryUserByEmailGlobal(email: string): Query<ScimUserBriefRow | null, string> {
  return { kind: SCIM_QUERY_USER_BY_EMAIL_GLOBAL, params: email };
}

export function scimQueryUserById(userId: string): Query<ScimUserRow | null, string> {
  return { kind: SCIM_QUERY_USER_BY_ID, params: userId };
}

export function scimQueryUserExists(params: ScimTenantIdParams): Query<ScimAvatarIdRow | null, ScimTenantIdParams> {
  return { kind: SCIM_QUERY_USER_EXISTS, params };
}

export function scimQueryAvatarIdsByUser(userId: string): Query<ScimAvatarIdRow, string> {
  return { kind: SCIM_QUERY_AVATAR_IDS_BY_USER, params: userId };
}

/* ── Command 工厂 ── */

export function scimCmdCreateUser(params: ScimCreateUserParams): Command<ScimCreateUserParams> {
  return { kind: SCIM_CMD_CREATE_USER, params };
}

export function scimCmdDeleteDeviceAvatars(avatarId: string): Command<string> {
  return { kind: SCIM_CMD_DELETE_DEVICE_AVATARS, params: avatarId };
}

export function scimCmdDeleteAutorunRunlog(avatarId: string): Command<string> {
  return { kind: SCIM_CMD_DELETE_AUTORUN_RUNLOG, params: avatarId };
}

export function scimCmdDeleteAutorunConfig(avatarId: string): Command<string> {
  return { kind: SCIM_CMD_DELETE_AUTORUN_CONFIG, params: avatarId };
}

export function scimCmdDeleteAvatarsByIdentity(userId: string): Command<string> {
  return { kind: SCIM_CMD_DELETE_AVATARS_BY_IDENTITY, params: userId };
}

export function scimCmdDeleteRefreshTokens(userId: string): Command<string> {
  return { kind: SCIM_CMD_DELETE_REFRESH_TOKENS, params: userId };
}

export function scimCmdDeleteIdentities(userId: string): Command<string> {
  return { kind: SCIM_CMD_DELETE_IDENTITIES, params: userId };
}

export function scimCmdDeleteUser(params: ScimDeleteUserParams): Command<ScimDeleteUserParams> {
  return { kind: SCIM_CMD_DELETE_USER, params };
}
