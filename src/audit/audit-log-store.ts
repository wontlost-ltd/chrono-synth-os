import { createHash, randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, AuditLogRow as KernelAuditLogRow } from '@chrono/kernel';
import {
  auditQueryById, auditQueryList, auditQueryCount,
  auditCmdRecordRequest, auditCmdRecordBusiness, auditCmdEnsureSchema,
  auditQueryChainTail, auditQueryChainRange,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import {
  GENESIS_HASH, computeRecordHash, verifyChain,
  type AuditHashInput, type ChainVerifyResult, type VerifiableRow,
} from './audit-hash-chain.js';

export type AuditEventKind = 'request' | 'business';
export type AuditActorType = 'user' | 'api_key' | 'system';

export interface AuditLogRecord {
  id: string;
  tenantId: string;
  eventKind: AuditEventKind;
  timestamp: number;
  createdAt: number;
  method: string;
  path: string;
  requestId: string;
  statusCode: number;
  latencyMs: number;
  apiKeyHash: string | null;
  userId: string | null;
  userEmail: string | null;
  actorType: AuditActorType | null;
  actorId: string | null;
  actionType: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  chainSeq: number | null;
  prevHash: string | null;
  recordHash: string | null;
}

export interface RequestAuditInput {
  tenantId: string;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  apiKey?: string;
  userId?: string | null;
  userEmail?: string | null;
  actorType?: AuditActorType | null;
  actorId?: string | null;
  actionType: string;
  payload?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface BusinessAuditInput {
  tenantId: string;
  actorType: AuditActorType;
  actorId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  payload?: Record<string, unknown> | null;
  requestId?: string | null;
  createdAt?: number;
}

export interface QueryAuditLogOptions {
  tenantId: string;
  limit?: number;
  offset?: number;
  eventKind?: AuditEventKind | 'all';
  actorId?: string;
  actionType?: string;
  targetType?: string;
  targetId?: string;
}

export function ensureAuditLogColumns(tx: SyncWriteUnitOfWork): void {
  registerCoreSelfExecutors();
  tx.execute(auditCmdEnsureSchema());
}

export function hashApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * 在事务内读取当前 tenant 的链尾（最大 chain_seq 行的 record_hash + chain_seq）。
 * 首次插入时返回 GENESIS_HASH 与 seq 0；调用方据此推导新行的 chainSeq = tail.seq + 1。
 *
 * 同事务读尾 + 写入 = 串行；多副本/多并发写入需依赖 DB 隔离级别（PG 默认 RC + 主键冲突）。
 * Phase 1A SQLite 单写线程模型下天然安全；PG 多副本场景 P1-F-ext 升级到 SELECT FOR UPDATE。
 */
function readChainTail(tx: SyncWriteUnitOfWork, tenantId: string): { seq: number; hash: string } {
  const row = tx.queryOne(auditQueryChainTail(tenantId));
  if (!row) return { seq: 0, hash: GENESIS_HASH };
  return { seq: row.chain_seq, hash: row.record_hash };
}

export function recordRequestAuditLog(tx: SyncWriteUnitOfWork, input: RequestAuditInput): void {
  registerCoreSelfExecutors();
  const createdAt = input.createdAt ?? Date.now();
  const id = randomUUID();
  const tail = readChainTail(tx, input.tenantId);
  const chainSeq = tail.seq + 1;
  const prevHash = tail.hash;
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
  const apiKeyHash = hashApiKey(input.apiKey);
  const latencyMs = Math.round(input.latencyMs * 100) / 100;
  const hashInput: AuditHashInput = {
    id,
    tenantId: input.tenantId,
    eventKind: 'request',
    createdAt,
    chainSeq,
    prevHash,
    method: input.method,
    path: input.path,
    requestId: input.requestId,
    statusCode: input.statusCode,
    latencyMs,
    apiKeyHash,
    userId: input.userId ?? null,
    userEmail: input.userEmail ?? null,
    actorType: input.actorType ?? null,
    actorId: input.actorId ?? null,
    actionType: input.actionType,
    targetType: null,
    targetId: null,
    payloadJson,
  };
  const recordHash = computeRecordHash(hashInput);
  tx.execute(auditCmdRecordRequest({
    id,
    tenantId: input.tenantId,
    createdAt,
    method: input.method,
    path: input.path,
    requestId: input.requestId,
    statusCode: input.statusCode,
    latencyMs,
    apiKeyHash,
    userId: input.userId ?? null,
    userEmail: input.userEmail ?? null,
    actorType: input.actorType ?? null,
    actorId: input.actorId ?? null,
    actionType: input.actionType,
    payloadJson,
    chainSeq,
    prevHash,
    recordHash,
  }));
}

export function recordBusinessAuditLog(tx: SyncWriteUnitOfWork, input: BusinessAuditInput): string {
  registerCoreSelfExecutors();
  const createdAt = input.createdAt ?? Date.now();
  const id = randomUUID();
  const tail = readChainTail(tx, input.tenantId);
  const chainSeq = tail.seq + 1;
  const prevHash = tail.hash;
  const path = `/audit/business/${input.actionType}`;
  const requestId = input.requestId ?? `audit:${id}`;
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
  const hashInput: AuditHashInput = {
    id,
    tenantId: input.tenantId,
    eventKind: 'business',
    createdAt,
    chainSeq,
    prevHash,
    method: 'EVENT',
    path,
    requestId,
    statusCode: 200,
    latencyMs: 0,
    apiKeyHash: null,
    userId: input.actorType === 'user' ? input.actorId : null,
    userEmail: null,
    actorType: input.actorType,
    actorId: input.actorId,
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: input.targetId,
    payloadJson,
  };
  const recordHash = computeRecordHash(hashInput);
  tx.execute(auditCmdRecordBusiness({
    id,
    tenantId: input.tenantId,
    createdAt,
    path,
    requestId,
    userId: input.actorType === 'user' ? input.actorId : null,
    actorType: input.actorType,
    actorId: input.actorId,
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: input.targetId,
    payloadJson,
    chainSeq,
    prevHash,
    recordHash,
  }));
  return id;
}

/**
 * 校验某 tenant 的审计链（自 fromSeq 至 toSeq；默认完整链）。
 *
 * 实现要点：
 * - 按 chain_seq 升序拉取所有行（仅含 chain_seq 非 NULL 的记录），交由纯函数 verifyChain。
 * - 单次返回最多 limit 行，便于大租户分批校验；不传 limit 表示一次拉完。
 */
export function verifyAuditChain(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  options: { fromSeq?: number; toSeq?: number; limit?: number } = {},
): ChainVerifyResult {
  registerCoreSelfExecutors();
  const rows = tx.queryMany(auditQueryChainRange({
    tenantId,
    fromSeq: options.fromSeq ?? null,
    toSeq: options.toSeq ?? null,
    limit: options.limit,
  }));
  const verifiable: VerifiableRow[] = rows
    .filter(row => row.chain_seq !== null && row.prev_hash !== null && row.record_hash !== null)
    .map(row => ({
      id: row.id,
      tenantId: row.tenant_id,
      eventKind: row.event_kind as 'request' | 'business',
      createdAt: Number(row.created_at),
      chainSeq: Number(row.chain_seq),
      prevHash: row.prev_hash as string,
      method: row.method,
      path: row.path,
      requestId: row.request_id,
      statusCode: Number(row.status_code),
      latencyMs: Number(row.latency_ms),
      apiKeyHash: row.api_key_hash,
      userId: row.user_id,
      userEmail: row.user_email,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actionType: row.action_type,
      targetType: row.target_type,
      targetId: row.target_id,
      payloadJson: row.payload_json,
      recordHash: row.record_hash as string,
    }));
  return verifyChain(verifiable);
}

export function queryAuditLog(tx: SyncWriteUnitOfWork, options: QueryAuditLogOptions): AuditLogRecord[] {
  registerCoreSelfExecutors();
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const rows = tx.queryMany(auditQueryList({
    tenantId: options.tenantId,
    limit,
    offset,
    eventKind: options.eventKind && options.eventKind !== 'all' ? options.eventKind : null,
    actorId: options.actorId ?? null,
    actionType: options.actionType ?? null,
    targetType: options.targetType ?? null,
    targetId: options.targetId ?? null,
  }));
  return rows.map(auditLogFromRow);
}

export function countAuditLogs(tx: SyncWriteUnitOfWork, options: Omit<QueryAuditLogOptions, 'limit' | 'offset'>): number {
  registerCoreSelfExecutors();
  const result = tx.queryOne(auditQueryCount({
    tenantId: options.tenantId,
    eventKind: options.eventKind && options.eventKind !== 'all' ? options.eventKind : null,
    actorId: options.actorId ?? null,
    actionType: options.actionType ?? null,
    targetType: options.targetType ?? null,
    targetId: options.targetId ?? null,
  }));
  return Number(result?.count ?? 0);
}

export function getAuditLogById(tx: SyncWriteUnitOfWork, tenantId: string, id: string): AuditLogRecord | null {
  registerCoreSelfExecutors();
  const row = tx.queryOne(auditQueryById(tenantId, id));
  return row ? auditLogFromRow(row) : null;
}

function auditLogFromRow(row: KernelAuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventKind: row.event_kind as AuditEventKind,
    timestamp: Number(row.timestamp),
    createdAt: Number(row.created_at),
    method: row.method,
    path: row.path,
    requestId: row.request_id,
    statusCode: Number(row.status_code),
    latencyMs: Number(row.latency_ms),
    apiKeyHash: row.api_key_hash,
    userId: row.user_id,
    userEmail: row.user_email,
    actorType: row.actor_type as AuditActorType | null,
    actorId: row.actor_id,
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: safeParsePayload(row.payload_json),
    chainSeq: row.chain_seq === null ? null : Number(row.chain_seq),
    prevHash: row.prev_hash,
    recordHash: row.record_hash,
  };
}

function safeParsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
