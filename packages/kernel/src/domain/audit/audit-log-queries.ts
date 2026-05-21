/**
 * 审计日志 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const AUDIT_QUERY_BY_ID = 'audit.byId' as const;
export const AUDIT_QUERY_LIST = 'audit.list' as const;
export const AUDIT_QUERY_COUNT = 'audit.count' as const;
export const AUDIT_QUERY_CHAIN_TAIL = 'audit.chainTail' as const;
export const AUDIT_QUERY_CHAIN_RANGE = 'audit.chainRange' as const;

/* ── Command Kinds ── */

export const AUDIT_CMD_RECORD_REQUEST = 'audit.recordRequest' as const;
export const AUDIT_CMD_RECORD_BUSINESS = 'audit.recordBusiness' as const;
export const AUDIT_CMD_ENSURE_SCHEMA = 'audit.ensureSchema' as const;
export const AUDIT_CMD_CHAIN_ACQUIRE_LOCK = 'audit.chainAcquireLock' as const;

/* ── 行类型 ── */

export interface AuditLogRow {
  id: string;
  tenant_id: string;
  event_kind: string;
  timestamp: number;
  created_at: number;
  method: string;
  path: string;
  request_id: string;
  status_code: number;
  latency_ms: number;
  api_key_hash: string | null;
  user_id: string | null;
  user_email: string | null;
  actor_type: string | null;
  actor_id: string | null;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string | null;
  /* Hash-chain columns added by P0-E. NULL on rows recorded before the
   * chain was rolled out; the verifier treats those as the genesis prefix
   * and only enforces continuity over the contiguous suffix that has
   * non-NULL hashes. */
  chain_seq: number | null;
  prev_hash: string | null;
  record_hash: string | null;
}

/* ── 参数类型 ── */

export interface AuditByIdParams {
  tenantId: string;
  id: string;
}

export interface AuditListParams {
  tenantId: string;
  limit: number;
  offset: number;
  eventKind?: string | null;
  actorId?: string | null;
  actionType?: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

export interface AuditCountParams {
  tenantId: string;
  eventKind?: string | null;
  actorId?: string | null;
  actionType?: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

export interface AuditRecordRequestParams {
  id: string;
  tenantId: string;
  createdAt: number;
  method: string;
  path: string;
  requestId: string;
  statusCode: number;
  latencyMs: number;
  apiKeyHash: string | null;
  userId: string | null;
  userEmail: string | null;
  actorType: string | null;
  actorId: string | null;
  actionType: string;
  payloadJson: string | null;
  /** Hash-chain inputs computed by the application layer before INSERT. */
  chainSeq: number;
  prevHash: string;
  recordHash: string;
}

export interface AuditRecordBusinessParams {
  id: string;
  tenantId: string;
  createdAt: number;
  path: string;
  requestId: string;
  userId: string | null;
  actorType: string;
  actorId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  payloadJson: string | null;
  /** Hash-chain inputs computed by the application layer before INSERT. */
  chainSeq: number;
  prevHash: string;
  recordHash: string;
}

export interface AuditChainTailParams {
  tenantId: string;
}

export interface AuditChainRangeParams {
  tenantId: string;
  fromSeq?: number | null;
  toSeq?: number | null;
  limit?: number;
}

export interface AuditChainTailRow {
  chain_seq: number;
  record_hash: string;
}

export interface AuditChainAcquireLockParams {
  tenantId: string;
}

/* ── Query 工厂 ── */

export function auditQueryById(tenantId: string, id: string): Query<AuditLogRow | null, AuditByIdParams> {
  return { kind: AUDIT_QUERY_BY_ID, params: { tenantId, id } };
}

export function auditQueryList(params: AuditListParams): Query<AuditLogRow, AuditListParams> {
  return { kind: AUDIT_QUERY_LIST, params };
}

export function auditQueryCount(params: AuditCountParams): Query<{ count: number } | null, AuditCountParams> {
  return { kind: AUDIT_QUERY_COUNT, params };
}

/* ── Command 工厂 ── */

export function auditCmdRecordRequest(params: AuditRecordRequestParams): Command<AuditRecordRequestParams> {
  return { kind: AUDIT_CMD_RECORD_REQUEST, params };
}

export function auditCmdRecordBusiness(params: AuditRecordBusinessParams): Command<AuditRecordBusinessParams> {
  return { kind: AUDIT_CMD_RECORD_BUSINESS, params };
}

export function auditCmdEnsureSchema(): Command<undefined> {
  return { kind: AUDIT_CMD_ENSURE_SCHEMA, params: undefined };
}

export function auditQueryChainTail(tenantId: string): Query<AuditChainTailRow | null, AuditChainTailParams> {
  return { kind: AUDIT_QUERY_CHAIN_TAIL, params: { tenantId } };
}

export function auditQueryChainRange(params: AuditChainRangeParams): Query<AuditLogRow, AuditChainRangeParams> {
  return { kind: AUDIT_QUERY_CHAIN_RANGE, params };
}

/**
 * Per-tenant transaction lock for chain append serialisation. On PG this
 * emits `SELECT pg_advisory_xact_lock(hashtext(tenant_id))`; on SQLite
 * it's a no-op because the engine is single-writer. Must be called
 * inside the same transaction as the subsequent tail read + insert.
 */
export function auditCmdChainAcquireLock(tenantId: string): Command<AuditChainAcquireLockParams> {
  return { kind: AUDIT_CMD_CHAIN_ACQUIRE_LOCK, params: { tenantId } };
}
