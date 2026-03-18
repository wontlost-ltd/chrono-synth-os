/**
 * 认证服务 Query/Command kind 常量与参数类型
 * 覆盖 AuthService + SsoUserService 的用户/令牌/订阅操作
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const AUTH_QUERY_USER_BY_EMAIL = 'auth.userByEmail' as const;
export const AUTH_QUERY_USER_BY_ID = 'auth.userById' as const;
export const AUTH_QUERY_REFRESH_TOKEN = 'auth.refreshToken' as const;
export const AUTH_QUERY_USER_BRIEF_BY_EMAIL = 'auth.userBriefByEmail' as const;
export const AUTH_QUERY_USER_COUNT_BY_TENANT = 'auth.userCountByTenant' as const;
export const AUTH_QUERY_SUB_EXISTS = 'auth.subExists' as const;

/* ── Command Kinds ── */

export const AUTH_CMD_CREATE_USER = 'auth.createUser' as const;
export const AUTH_CMD_CREATE_SUBSCRIPTION = 'auth.createSubscription' as const;
export const AUTH_CMD_CREATE_REFRESH_TOKEN = 'auth.createRefreshToken' as const;
export const AUTH_CMD_REVOKE_TOKEN_BY_ID = 'auth.revokeTokenById' as const;
export const AUTH_CMD_REVOKE_TOKEN_BY_HASH = 'auth.revokeTokenByHash' as const;
export const AUTH_CMD_REVOKE_TOKENS_BY_USER = 'auth.revokeTokensByUser' as const;
export const AUTH_CMD_CLEANUP_EXPIRED_TOKENS = 'auth.cleanupExpiredTokens' as const;
export const AUTH_CMD_UPDATE_DISPLAY_NAME = 'auth.updateDisplayName' as const;

/* ── 行类型 ── */

export interface AuthUserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: string;
  readonly tenant_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AuthUserBriefRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly role: string;
}

export interface AuthRefreshTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly is_revoked: number;
  readonly expires_at: number;
  readonly created_at: number;
}

export interface AuthSubExistsRow {
  readonly id: string;
}

export interface AuthUserCountRow {
  readonly count: number;
}

/* ── 参数类型 ── */

export interface AuthCreateUserParams {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  tenantId: string;
  now: number;
}

export interface AuthCreateSubscriptionParams {
  id: string;
  tenantId: string;
  stripeCustomerId: string | null;
  periodStart: number;
  periodEnd: number;
  now: number;
}

export interface AuthCreateRefreshTokenParams {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  now: number;
}

export interface AuthCleanupExpiredTokensParams {
  cutoff: number;
}

export interface AuthUpdateDisplayNameParams {
  userId: string;
  displayName: string;
  now: number;
}

/* ── Query 工厂 ── */

export function authQueryUserByEmail(email: string): Query<AuthUserRow | null, string> {
  return { kind: AUTH_QUERY_USER_BY_EMAIL, params: email };
}

export function authQueryUserById(userId: string): Query<AuthUserRow | null, string> {
  return { kind: AUTH_QUERY_USER_BY_ID, params: userId };
}

export function authQueryRefreshToken(tokenHash: string): Query<AuthRefreshTokenRow | null, string> {
  return { kind: AUTH_QUERY_REFRESH_TOKEN, params: tokenHash };
}

export function authQueryUserBriefByEmail(email: string): Query<AuthUserBriefRow | null, string> {
  return { kind: AUTH_QUERY_USER_BRIEF_BY_EMAIL, params: email };
}

export function authQueryUserCountByTenant(tenantId: string): Query<AuthUserCountRow | null, string> {
  return { kind: AUTH_QUERY_USER_COUNT_BY_TENANT, params: tenantId };
}

export function authQuerySubExists(tenantId: string): Query<AuthSubExistsRow | null, string> {
  return { kind: AUTH_QUERY_SUB_EXISTS, params: tenantId };
}

/* ── Command 工厂 ── */

export function authCmdCreateUser(params: AuthCreateUserParams): Command<AuthCreateUserParams> {
  return { kind: AUTH_CMD_CREATE_USER, params };
}

export function authCmdCreateSubscription(params: AuthCreateSubscriptionParams): Command<AuthCreateSubscriptionParams> {
  return { kind: AUTH_CMD_CREATE_SUBSCRIPTION, params };
}

export function authCmdCreateRefreshToken(params: AuthCreateRefreshTokenParams): Command<AuthCreateRefreshTokenParams> {
  return { kind: AUTH_CMD_CREATE_REFRESH_TOKEN, params };
}

export function authCmdRevokeTokenById(id: string): Command<string> {
  return { kind: AUTH_CMD_REVOKE_TOKEN_BY_ID, params: id };
}

export function authCmdRevokeTokenByHash(tokenHash: string): Command<string> {
  return { kind: AUTH_CMD_REVOKE_TOKEN_BY_HASH, params: tokenHash };
}

export function authCmdRevokeTokensByUser(userId: string): Command<string> {
  return { kind: AUTH_CMD_REVOKE_TOKENS_BY_USER, params: userId };
}

export function authCmdCleanupExpiredTokens(params: AuthCleanupExpiredTokensParams): Command<AuthCleanupExpiredTokensParams> {
  return { kind: AUTH_CMD_CLEANUP_EXPIRED_TOKENS, params };
}

export function authCmdUpdateDisplayName(params: AuthUpdateDisplayNameParams): Command<AuthUpdateDisplayNameParams> {
  return { kind: AUTH_CMD_UPDATE_DISPLAY_NAME, params };
}
