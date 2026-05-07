/**
 * 用户 OAuth2 token Query/Command kind 常量与工厂
 */

import type { Query, Command } from '../../ports/query.js';
import type {
  UserOauthTokenRow,
  UserOauthUpsertParams,
  UserOauthQueryParams,
  UserOauthRevokeParams,
} from './user-oauth-types.js';

/* ── Query Kinds ─────────────────────────────────────────────────── */

export const UOAUTH_QUERY_BY_USER_PROVIDER_SCOPE = 'userOauth.byUserProviderScope' as const;
export const UOAUTH_QUERY_LIST_BY_USER = 'userOauth.listByUser' as const;

/* ── Command Kinds ───────────────────────────────────────────────── */

export const UOAUTH_CMD_UPSERT = 'userOauth.upsert' as const;
export const UOAUTH_CMD_REVOKE = 'userOauth.revoke' as const;

/* ── 参数类型 ────────────────────────────────────────────────────── */

export interface UserOauthListByUserParams {
  readonly tenantId: string;
  readonly userId: string;
}

/* ── Query 工厂 ─────────────────────────────────────────────────── */

export function uoauthQueryByUserProviderScope(p: UserOauthQueryParams): Query<UserOauthTokenRow | null, UserOauthQueryParams> {
  return { kind: UOAUTH_QUERY_BY_USER_PROVIDER_SCOPE, params: p };
}

export function uoauthQueryListByUser(p: UserOauthListByUserParams): Query<UserOauthTokenRow, UserOauthListByUserParams> {
  return { kind: UOAUTH_QUERY_LIST_BY_USER, params: p };
}

/* ── Command 工厂 ───────────────────────────────────────────────── */

export function uoauthCmdUpsert(p: UserOauthUpsertParams): Command<UserOauthUpsertParams> {
  return { kind: UOAUTH_CMD_UPSERT, params: p };
}

export function uoauthCmdRevoke(p: UserOauthRevokeParams): Command<UserOauthRevokeParams> {
  return { kind: UOAUTH_CMD_REVOKE, params: p };
}
