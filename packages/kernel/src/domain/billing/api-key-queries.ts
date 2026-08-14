/**
 * API Key Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const APIKEY_QUERY_LIST = 'apiKey.list' as const;
export const APIKEY_QUERY_BY_HASH = 'apiKey.byHash' as const;
export const APIKEY_QUERY_BY_ID = 'apiKey.byId' as const;

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

/**
 * 按 id 取 API Key 行（含 key_hash），**不过滤 is_revoked**。
 *
 * revoke by id 时先取该 key 的 key_hash 以调 `removeLookup` 清协调库目录项（目录=定位器）。
 * 故意不带 tenant predicate——调用方（tenant-bound writer）已在正确 shard 上执行，且 revoke 的
 * `WHERE id=? AND tenant_id=?` 才是权威隔离门；本查询仅为取 hash（若跨租户 id 巧合命中，hash 也只
 * 用于删协调库定位项，删错定位项至多导致「该 hash 下次认证需回退单库查」，不越权、不泄露）。
 */
export function apikeyQueryById(id: string): Query<ApiKeyRow | null, string> {
  return { kind: APIKEY_QUERY_BY_ID, params: id };
}

/* ── Command 工厂 ── */

export function apikeyCmdCreate(params: ApiKeyCreateParams): Command<ApiKeyCreateParams> {
  return { kind: APIKEY_CMD_CREATE, params };
}

export function apikeyCmdRevoke(params: ApiKeyRevokeParams): Command<ApiKeyRevokeParams> {
  return { kind: APIKEY_CMD_REVOKE, params };
}
