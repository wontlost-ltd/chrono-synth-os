import { createHash, randomUUID } from 'node:crypto';
import type { IDatabase, SqlValue } from '../storage/database.js';

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

interface AuditLogRow {
  id: string;
  tenant_id: string;
  event_kind: AuditEventKind;
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
  actor_type: AuditActorType | null;
  actor_id: string | null;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string | null;
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

const AUDIT_SELECT = `
  SELECT
    id,
    tenant_id,
    event_kind,
    timestamp,
    created_at,
    method,
    path,
    request_id,
    status_code,
    latency_ms,
    api_key_hash,
    user_id,
    user_email,
    actor_type,
    actor_id,
    action_type,
    target_type,
    target_id,
    payload_json
  FROM audit_log
`;

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
      `UPDATE audit_log
       SET created_at = timestamp
       WHERE created_at = 0`,
    ).run();
  } catch {
    /* 忽略兼容性失败 */
  }
}

export function hashApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

export function recordRequestAuditLog(db: IDatabase, input: RequestAuditInput): void {
  const createdAt = input.createdAt ?? Date.now();
  db.prepare<void>(
    `INSERT INTO audit_log (
      id, tenant_id, event_kind, timestamp, created_at,
      method, path, request_id, status_code, latency_ms,
      api_key_hash, user_id, user_email,
      actor_type, actor_id, action_type, target_type, target_id, payload_json
    ) VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    randomUUID(),
    input.tenantId,
    createdAt,
    createdAt,
    input.method,
    input.path,
    input.requestId,
    input.statusCode,
    Math.round(input.latencyMs * 100) / 100,
    hashApiKey(input.apiKey),
    input.userId ?? null,
    input.userEmail ?? null,
    input.actorType ?? null,
    input.actorId ?? null,
    input.actionType,
    input.payload ? JSON.stringify(input.payload) : null,
  );
}

export function recordBusinessAuditLog(db: IDatabase, input: BusinessAuditInput): string {
  const createdAt = input.createdAt ?? Date.now();
  const id = randomUUID();
  db.prepare<void>(
    `INSERT INTO audit_log (
      id, tenant_id, event_kind, timestamp, created_at,
      method, path, request_id, status_code, latency_ms,
      api_key_hash, user_id, user_email,
      actor_type, actor_id, action_type, target_type, target_id, payload_json
    ) VALUES (?, ?, 'business', ?, ?, 'EVENT', ?, ?, 200, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.tenantId,
    createdAt,
    createdAt,
    `/audit/business/${input.actionType}`,
    input.requestId ?? `audit:${id}`,
    input.actorType === 'user' ? input.actorId : null,
    input.actorType,
    input.actorId,
    input.actionType,
    input.targetType,
    input.targetId,
    input.payload ? JSON.stringify(input.payload) : null,
  );
  return id;
}

export function queryAuditLog(db: IDatabase, options: QueryAuditLogOptions): AuditLogRecord[] {
  const where: string[] = ['tenant_id = ?'];
  const params: SqlValue[] = [options.tenantId];

  if (options.eventKind && options.eventKind !== 'all') {
    where.push('event_kind = ?');
    params.push(options.eventKind);
  }
  if (options.actorId) {
    where.push('actor_id = ?');
    params.push(options.actorId);
  }
  if (options.actionType) {
    where.push('action_type = ?');
    params.push(options.actionType);
  }
  if (options.targetType) {
    where.push('target_type = ?');
    params.push(options.targetType);
  }
  if (options.targetId) {
    where.push('target_id = ?');
    params.push(options.targetId);
  }

  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const rows = db.prepare<AuditLogRow>(
    `${AUDIT_SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, timestamp DESC
     LIMIT ? OFFSET ?`,
  ).all(...params);
  return rows.map(auditLogFromRow);
}

export function countAuditLogs(db: IDatabase, options: Omit<QueryAuditLogOptions, 'limit' | 'offset'>): number {
  const where: string[] = ['tenant_id = ?'];
  const params: SqlValue[] = [options.tenantId];

  if (options.eventKind && options.eventKind !== 'all') {
    where.push('event_kind = ?');
    params.push(options.eventKind);
  }
  if (options.actorId) {
    where.push('actor_id = ?');
    params.push(options.actorId);
  }
  if (options.actionType) {
    where.push('action_type = ?');
    params.push(options.actionType);
  }
  if (options.targetType) {
    where.push('target_type = ?');
    params.push(options.targetType);
  }
  if (options.targetId) {
    where.push('target_id = ?');
    params.push(options.targetId);
  }

  return db.prepare<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM audit_log
     WHERE ${where.join(' AND ')}`,
  ).get(...params)?.count ?? 0;
}

export function getAuditLogById(db: IDatabase, tenantId: string, id: string): AuditLogRecord | null {
  const row = db.prepare<AuditLogRow>(
    `${AUDIT_SELECT}
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`,
  ).get(tenantId, id);
  return row ? auditLogFromRow(row) : null;
}

function auditLogFromRow(row: AuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventKind: row.event_kind,
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
    actorType: row.actor_type,
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
