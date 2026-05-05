/**
 * 审计日志 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { SqlValue } from '../database.js';
import type {
  AuditLogRow, AuditByIdParams, AuditListParams, AuditCountParams,
  AuditRecordRequestParams, AuditRecordBusinessParams,
} from '@chrono/kernel';
import {
  AUDIT_QUERY_BY_ID, AUDIT_QUERY_LIST, AUDIT_QUERY_COUNT,
  AUDIT_CMD_RECORD_REQUEST, AUDIT_CMD_RECORD_BUSINESS, AUDIT_CMD_ENSURE_SCHEMA,
} from '@chrono/kernel';

const AUDIT_SELECT = `
  SELECT id, tenant_id, event_kind, timestamp, created_at,
    method, path, request_id, status_code, latency_ms,
    api_key_hash, user_id, user_email,
    actor_type, actor_id, action_type, target_type, target_id, payload_json
  FROM audit_log
`;

function buildAuditWhere(p: AuditCountParams): { where: string; params: SqlValue[] } {
  const clauses: string[] = ['tenant_id = ?'];
  const params: SqlValue[] = [p.tenantId];

  if (p.eventKind && p.eventKind !== 'all') {
    clauses.push('event_kind = ?');
    params.push(p.eventKind);
  }
  if (p.actorId) {
    clauses.push('actor_id = ?');
    params.push(p.actorId);
  }
  if (p.actionType) {
    clauses.push('action_type = ?');
    params.push(p.actionType);
  }
  if (p.targetType) {
    clauses.push('target_type = ?');
    params.push(p.targetType);
  }
  if (p.targetId) {
    clauses.push('target_id = ?');
    params.push(p.targetId);
  }

  return { where: clauses.join(' AND '), params };
}

export function registerAuditLogExecutors(): void {
  /* ── Queries ── */

  registerQuery<AuditLogRow | null, AuditByIdParams>(AUDIT_QUERY_BY_ID, (db, p) => {
    return db.prepare<AuditLogRow>(
      `${AUDIT_SELECT} WHERE tenant_id = ? AND id = ? LIMIT 1`,
    ).get(p.tenantId, p.id) ?? null;
  });

  registerQuery<AuditLogRow, AuditListParams>(AUDIT_QUERY_LIST, (db, p) => {
    const { where, params } = buildAuditWhere(p);
    params.push(p.limit, p.offset);
    return db.prepare<AuditLogRow>(
      `${AUDIT_SELECT} WHERE ${where} ORDER BY created_at DESC, timestamp DESC LIMIT ? OFFSET ?`,
    ).all(...params) as unknown as AuditLogRow;
  });

  registerQuery<{ count: number } | null, AuditCountParams>(AUDIT_QUERY_COUNT, (db, p) => {
    const { where, params } = buildAuditWhere(p);
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM audit_log WHERE ${where}`,
    ).get(...params) ?? null;
  });

  /* ── Commands ── */

  registerCommand<AuditRecordRequestParams>(AUDIT_CMD_RECORD_REQUEST, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO audit_log (
        id, tenant_id, event_kind, timestamp, created_at,
        method, path, request_id, status_code, latency_ms,
        api_key_hash, user_id, user_email,
        actor_type, actor_id, action_type, target_type, target_id, payload_json
      ) VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      p.id, p.tenantId, p.createdAt, p.createdAt,
      p.method, p.path, p.requestId, p.statusCode, p.latencyMs,
      p.apiKeyHash, p.userId, p.userEmail,
      p.actorType, p.actorId, p.actionType, p.payloadJson,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<undefined>(AUDIT_CMD_ENSURE_SCHEMA, (db) => {
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
      try { db.prepare<void>(statement).run(); } catch { /* 已升级 */ }
    }
    try {
      db.prepare<void>('UPDATE audit_log SET created_at = timestamp WHERE created_at = 0').run();
    } catch { /* ignore */ }
    return { rowsAffected: 0 };
  });

  registerCommand<AuditRecordBusinessParams>(AUDIT_CMD_RECORD_BUSINESS, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO audit_log (
        id, tenant_id, event_kind, timestamp, created_at,
        method, path, request_id, status_code, latency_ms,
        api_key_hash, user_id, user_email,
        actor_type, actor_id, action_type, target_type, target_id, payload_json
      ) VALUES (?, ?, 'business', ?, ?, 'EVENT', ?, ?, 200, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.createdAt, p.createdAt,
      p.path, p.requestId, p.userId,
      p.actorType, p.actorId, p.actionType, p.targetType, p.targetId, p.payloadJson,
    );
    return { rowsAffected: result.changes };
  });
}
