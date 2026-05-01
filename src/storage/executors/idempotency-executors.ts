/**
 * 幂等键 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  IDEM_QUERY_EXISTING, IDEM_QUERY_ID_BY_KEY,
  IDEM_CMD_CLEANUP_EXPIRED, IDEM_CMD_INSERT, IDEM_CMD_COMPLETE, IDEM_CMD_DELETE,
} from '@chrono/kernel';
import type {
  IdemRow, IdemIdRow,
  IdemExistingParams, IdemInsertParams, IdemCompleteParams,
} from '@chrono/kernel';

export function registerIdempotencyExecutors(): void {
  registerQuery<IdemRow | null, IdemExistingParams>(IDEM_QUERY_EXISTING, (db, p) => {
    return db.prepare<IdemRow>(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = ? AND scope_key = ? AND idempotency_key = ? AND expires_at > ?
       LIMIT 1`,
    ).get(p.tenantId, p.scopeKey, p.idempotencyKey, p.now) ?? null;
  });

  registerQuery<IdemIdRow | null, Omit<IdemExistingParams, 'now'>>(IDEM_QUERY_ID_BY_KEY, (db, p) => {
    return db.prepare<IdemIdRow>(
      `SELECT id FROM idempotency_keys
       WHERE tenant_id = ? AND scope_key = ? AND idempotency_key = ?
       LIMIT 1`,
    ).get(p.tenantId, p.scopeKey, p.idempotencyKey) ?? null;
  });

  registerCommand<number>(IDEM_CMD_CLEANUP_EXPIRED, (db, now) => {
    const result = db.prepare<void>(
      'DELETE FROM idempotency_keys WHERE expires_at <= ?',
    ).run(now);
    return { rowsAffected: result.changes };
  });

  registerCommand<IdemInsertParams>(IDEM_CMD_INSERT, (db, p) => {
    // INSERT OR IGNORE 保证并发下的原子性声明：rowsAffected=0 表示已被其他请求捷足先登
    const result = db.prepare<void>(
      `INSERT OR IGNORE INTO idempotency_keys (
        id, tenant_id, scope_key, idempotency_key, request_hash, request_method, request_path,
        state, response_status, response_content_type, response_headers_json, response_body,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.scopeKey, p.idempotencyKey, p.requestHash,
      p.requestMethod, p.requestPath, p.now, p.expiresAt,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<IdemCompleteParams>(IDEM_CMD_COMPLETE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE idempotency_keys
       SET state = 'completed',
           response_status = ?,
           response_content_type = ?,
           response_headers_json = ?,
           response_body = ?
       WHERE id = ?`,
    ).run(p.responseStatus, p.responseContentType, p.responseHeadersJson, p.responseBody, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(IDEM_CMD_DELETE, (db, id) => {
    const result = db.prepare<void>(
      'DELETE FROM idempotency_keys WHERE id = ?',
    ).run(id);
    return { rowsAffected: result.changes };
  });
}
