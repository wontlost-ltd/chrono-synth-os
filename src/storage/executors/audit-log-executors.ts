/**
 * 审计日志 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { SqlValue } from '../database.js';
import type {
  AuditLogRow, AuditByIdParams, AuditListParams, AuditCountParams,
  AuditRecordRequestParams, AuditRecordBusinessParams,
  AuditChainTailParams, AuditChainTailRow, AuditChainRangeParams,
} from '@chrono/kernel';
import {
  AUDIT_QUERY_BY_ID, AUDIT_QUERY_LIST, AUDIT_QUERY_COUNT,
  AUDIT_QUERY_CHAIN_TAIL, AUDIT_QUERY_CHAIN_RANGE,
  AUDIT_CMD_RECORD_REQUEST, AUDIT_CMD_RECORD_BUSINESS, AUDIT_CMD_ENSURE_SCHEMA,
} from '@chrono/kernel';

const AUDIT_SELECT = `
  SELECT id, tenant_id, event_kind, timestamp, created_at,
    method, path, request_id, status_code, latency_ms,
    api_key_hash, user_id, user_email,
    actor_type, actor_id, action_type, target_type, target_id, payload_json,
    chain_seq, prev_hash, record_hash
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

  registerQuery<AuditLogRow[], AuditListParams>(AUDIT_QUERY_LIST, (db, p) => {
    const { where, params } = buildAuditWhere(p);
    params.push(p.limit, p.offset);
    return db.prepare<AuditLogRow>(
      `${AUDIT_SELECT} WHERE ${where} ORDER BY created_at DESC, timestamp DESC LIMIT ? OFFSET ?`,
    ).all(...params);
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
        actor_type, actor_id, action_type, target_type, target_id, payload_json,
        chain_seq, prev_hash, record_hash
      ) VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.createdAt, p.createdAt,
      p.method, p.path, p.requestId, p.statusCode, p.latencyMs,
      p.apiKeyHash, p.userId, p.userEmail,
      p.actorType, p.actorId, p.actionType, p.payloadJson,
      p.chainSeq, p.prevHash, p.recordHash,
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
      /* P0-E hash chain columns. Nullable so legacy rows survive; new writes
       * always populate them. The verifier ignores rows where chain_seq IS NULL. */
      'ALTER TABLE audit_log ADD COLUMN chain_seq INTEGER',
      'ALTER TABLE audit_log ADD COLUMN prev_hash TEXT',
      'ALTER TABLE audit_log ADD COLUMN record_hash TEXT',
    ];
    for (const statement of statements) {
      try { db.prepare<void>(statement).run(); } catch { /* 已升级 */ }
    }
    try {
      db.prepare<void>('UPDATE audit_log SET created_at = timestamp WHERE created_at = 0').run();
    } catch { /* ignore */ }
    /* Index for tail lookup; same statement runs idempotently on both engines. */
    try {
      db.prepare<void>(
        'CREATE INDEX IF NOT EXISTS idx_audit_log_chain ON audit_log(tenant_id, chain_seq)',
      ).run();
    } catch { /* ignore */ }
    return { rowsAffected: 0 };
  });

  registerCommand<AuditRecordBusinessParams>(AUDIT_CMD_RECORD_BUSINESS, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO audit_log (
        id, tenant_id, event_kind, timestamp, created_at,
        method, path, request_id, status_code, latency_ms,
        api_key_hash, user_id, user_email,
        actor_type, actor_id, action_type, target_type, target_id, payload_json,
        chain_seq, prev_hash, record_hash
      ) VALUES (?, ?, 'business', ?, ?, 'EVENT', ?, ?, 200, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.createdAt, p.createdAt,
      p.path, p.requestId, p.userId,
      p.actorType, p.actorId, p.actionType, p.targetType, p.targetId, p.payloadJson,
      p.chainSeq, p.prevHash, p.recordHash,
    );
    return { rowsAffected: result.changes };
  });

  /* ── 哈希链 Queries ── */

  registerQuery<AuditChainTailRow | null, AuditChainTailParams>(AUDIT_QUERY_CHAIN_TAIL, (db, p) => {
    /* 仅返回参与链的记录（chain_seq IS NOT NULL）；老数据视作 NULL 链头 */
    return db.prepare<AuditChainTailRow>(
      `SELECT chain_seq, record_hash FROM audit_log
        WHERE tenant_id = ? AND chain_seq IS NOT NULL
        ORDER BY chain_seq DESC LIMIT 1`,
    ).get(p.tenantId) ?? null;
  });

  registerQuery<AuditLogRow[], AuditChainRangeParams>(AUDIT_QUERY_CHAIN_RANGE, (db, p) => {
    const clauses: string[] = ['tenant_id = ?', 'chain_seq IS NOT NULL'];
    const params: SqlValue[] = [p.tenantId];
    if (p.fromSeq != null) {
      clauses.push('chain_seq >= ?');
      params.push(p.fromSeq);
    }
    if (p.toSeq != null) {
      clauses.push('chain_seq <= ?');
      params.push(p.toSeq);
    }
    let sql = `${AUDIT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY chain_seq ASC`;
    if (p.limit != null) {
      sql += ' LIMIT ?';
      params.push(p.limit);
    }
    return db.prepare<AuditLogRow>(sql).all(...params);
  });
}
