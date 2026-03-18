import { createHash, randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork, AuditLogRow as KernelAuditLogRow } from '@chrono/kernel';
import {
  auditQueryById, auditQueryList, auditQueryCount,
  auditCmdRecordRequest, auditCmdRecordBusiness,
} from '@chrono/kernel';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
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

export function ensureAuditLogColumns(db: IDatabase): void {
  const statements = [
    'ALTER TABLE audit_log ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE audit_log ADD COLUMN event_kind TEXT NOT NULL DEFAULT \'request\'',
    'ALTER TABLE audit_log ADD COLUMN user_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN user_email TEXT',
    'ALTER TABLE audit_log ADD COLUMN action_type TEXT DEFAULT \'other\'',
    'ALTER TABLE audit_log ADD COLUMN actor_type TEXT',
    'ALTER TABLE audit_log ADD COLUMN actor_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN target_type TEXT',
    'ALTER TABLE audit_log ADD COLUMN target_id TEXT',
    'ALTER TABLE audit_log ADD COLUMN payload_json TEXT',
  ];

  for (const statement of statements) {
    try {
      db.prepare<void>(statement).run();
    } catch {
      /* 兼容已升级数据库 */
    }
  }

  try {
    db.prepare<void>(
      `UPDATE audit_log SET created_at = timestamp WHERE created_at = 0`,
    ).run();
  } catch {
    /* 忽略兼容性失败 */
  }
}

export function hashApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function getTx(db: IDatabase): SyncWriteUnitOfWork {
  registerCoreSelfExecutors();
  return directUnitOfWork(db);
}

export function recordRequestAuditLog(db: IDatabase, input: RequestAuditInput): void {
  const tx = getTx(db);
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

export function recordBusinessAuditLog(db: IDatabase, input: BusinessAuditInput): string {
  const tx = getTx(db);
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

export function queryAuditLog(db: IDatabase, options: QueryAuditLogOptions): AuditLogRecord[] {
  const tx = getTx(db);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const rows = [...tx.queryMany(auditQueryList({
    tenantId: options.tenantId,
    limit,
    offset,
    eventKind: options.eventKind && options.eventKind !== 'all' ? options.eventKind : null,
    actorId: options.actorId ?? null,
    actionType: options.actionType ?? null,
    targetType: options.targetType ?? null,
    targetId: options.targetId ?? null,
  }))] as unknown as KernelAuditLogRow[];
  return rows.map(auditLogFromRow);
}

export function countAuditLogs(db: IDatabase, options: Omit<QueryAuditLogOptions, 'limit' | 'offset'>): number {
  const tx = getTx(db);
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

export function getAuditLogById(db: IDatabase, tenantId: string, id: string): AuditLogRecord | null {
  const tx = getTx(db);
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
