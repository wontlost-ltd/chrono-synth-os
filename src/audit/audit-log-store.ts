import { createHash, randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, AuditLogRow as KernelAuditLogRow } from '@chrono/kernel';
import {
  auditQueryById, auditQueryList, auditQueryCount,
  auditCmdRecordRequest, auditCmdRecordBusiness, auditCmdEnsureSchema,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

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

export function recordRequestAuditLog(tx: SyncWriteUnitOfWork, input: RequestAuditInput): void {
  registerCoreSelfExecutors();
  const createdAt = input.createdAt ?? Date.now();
  tx.execute(auditCmdRecordRequest({
    id: randomUUID(),
    tenantId: input.tenantId,
    createdAt,
    method: input.method,
    path: input.path,
    requestId: input.requestId,
    statusCode: input.statusCode,
    latencyMs: Math.round(input.latencyMs * 100) / 100,
    apiKeyHash: hashApiKey(input.apiKey),
    userId: input.userId ?? null,
    userEmail: input.userEmail ?? null,
    actorType: input.actorType ?? null,
    actorId: input.actorId ?? null,
    actionType: input.actionType,
    payloadJson: input.payload ? JSON.stringify(input.payload) : null,
  }));
}

export function recordBusinessAuditLog(tx: SyncWriteUnitOfWork, input: BusinessAuditInput): string {
  registerCoreSelfExecutors();
  const createdAt = input.createdAt ?? Date.now();
  const id = randomUUID();
  tx.execute(auditCmdRecordBusiness({
    id,
    tenantId: input.tenantId,
    createdAt,
    path: `/audit/business/${input.actionType}`,
    requestId: input.requestId ?? `audit:${id}`,
    userId: input.actorType === 'user' ? input.actorId : null,
    actorType: input.actorType,
    actorId: input.actorId,
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: input.targetId,
    payloadJson: input.payload ? JSON.stringify(input.payload) : null,
  }));
  return id;
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
