/**
 * API Key Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const APIKEY_QUERY_LIST = 'apiKey.list' as const;
export const APIKEY_QUERY_BY_HASH = 'apiKey.byHash' as const;

/* ── Command Kinds ── */

export const APIKEY_CMD_CREATE = 'apiKey.create' as const;
export const APIKEY_CMD_REVOKE = 'apiKey.revoke' as const;

/* ── 行类型 ── */

export interface ApiKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly key_hash: string;
  readonly plan_id: string;
  readonly is_revoked: number;
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface ApiKeyCreateParams {
  id: string;
  tenantId: string;
  keyHash: string;
  planId: string;
  now: number;
}

export interface ApiKeyRevokeParams {
  id: string;
  tenantId: string;
}

/* ── Query 工厂 ── */

export function apikeyQueryList(tenantId: string): Query<ApiKeyRow, string> {
  return { kind: APIKEY_QUERY_LIST, params: tenantId };
}

export function apikeyQueryByHash(keyHash: string): Query<ApiKeyRow | null, string> {
  return { kind: APIKEY_QUERY_BY_HASH, params: keyHash };
}

/* ── Command 工厂 ── */

export function apikeyCmdCreate(params: ApiKeyCreateParams): Command<ApiKeyCreateParams> {
  return { kind: APIKEY_CMD_CREATE, params };
}

export function apikeyCmdRevoke(params: ApiKeyRevokeParams): Command<ApiKeyRevokeParams> {
  return { kind: APIKEY_CMD_REVOKE, params };
}
