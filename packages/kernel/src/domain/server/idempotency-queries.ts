/**
 * 幂等键 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const IDEM_QUERY_EXISTING = 'idempotency.existing' as const;
export const IDEM_QUERY_ID_BY_KEY = 'idempotency.idByKey' as const;

/* ── Command Kinds ── */

export const IDEM_CMD_CLEANUP_EXPIRED = 'idempotency.cleanupExpired' as const;
export const IDEM_CMD_INSERT = 'idempotency.insert' as const;
export const IDEM_CMD_COMPLETE = 'idempotency.complete' as const;
export const IDEM_CMD_DELETE = 'idempotency.delete' as const;

/* ── 行类型 ── */

export interface IdemRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly scope_key: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly request_method: string;
  readonly request_path: string;
  readonly state: string;
  readonly response_status: number | null;
  readonly response_content_type: string | null;
  readonly response_headers_json: string | null;
  readonly response_body: string | null;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface IdemIdRow {
  readonly id: string;
}

/* ── 参数类型 ── */

export interface IdemExistingParams {
  tenantId: string;
  scopeKey: string;
  idempotencyKey: string;
  now: number;
}

export interface IdemInsertParams {
  id: string;
  tenantId: string;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  requestMethod: string;
  requestPath: string;
  now: number;
  expiresAt: number;
}

export interface IdemCompleteParams {
  id: string;
  responseStatus: number;
  responseContentType: string | null;
  responseHeadersJson: string | null;
  responseBody: string;
}

/* ── Query 工厂 ── */

export function idemQueryExisting(params: IdemExistingParams): Query<IdemRow | null, IdemExistingParams> {
  return { kind: IDEM_QUERY_EXISTING, params };
}

export function idemQueryIdByKey(params: Omit<IdemExistingParams, 'now'>): Query<IdemIdRow | null, Omit<IdemExistingParams, 'now'>> {
  return { kind: IDEM_QUERY_ID_BY_KEY, params };
}

/* ── Command 工厂 ── */

export function idemCmdCleanupExpired(now: number): Command<number> {
  return { kind: IDEM_CMD_CLEANUP_EXPIRED, params: now };
}

export function idemCmdInsert(params: IdemInsertParams): Command<IdemInsertParams> {
  return { kind: IDEM_CMD_INSERT, params };
}

export function idemCmdComplete(params: IdemCompleteParams): Command<IdemCompleteParams> {
  return { kind: IDEM_CMD_COMPLETE, params };
}

export function idemCmdDelete(id: string): Command<string> {
  return { kind: IDEM_CMD_DELETE, params: id };
}
