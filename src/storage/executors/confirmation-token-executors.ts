/**
 * 对话确认 Token SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  CTOKEN_QUERY_BY_ID, CTOKEN_CMD_INSERT, CTOKEN_CMD_CONSUME, CTOKEN_CMD_PRUNE_EXPIRED,
} from '@chrono/kernel';
import type {
  CtokenRow, CtokenInsertParams, CtokenConsumeParams, CtokenPruneParams,
} from '@chrono/kernel';

export function registerConfirmationTokenExecutors(): void {
  registerQuery<CtokenRow | null, string>(CTOKEN_QUERY_BY_ID, (db, id) => {
    return db.prepare<CtokenRow>(
      `SELECT tenant_id, persona_id, session_id, external_user_id, input_hash, expires_at, consumed_at
         FROM conversation_confirmation_tokens
        WHERE id = ?`,
    ).get(id) ?? null;
  });

  registerCommand<CtokenInsertParams>(CTOKEN_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO conversation_confirmation_tokens
        (id, tenant_id, persona_id, session_id, external_user_id,
         requested_topic, requested_rule, input_hash, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.sessionId, p.externalUserId,
      p.topic, p.rule, p.inputHash, p.issuedAt, p.expiresAt,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<CtokenConsumeParams>(CTOKEN_CMD_CONSUME, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE conversation_confirmation_tokens
          SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL`,
    ).run(p.consumedAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<CtokenPruneParams>(CTOKEN_CMD_PRUNE_EXPIRED, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM conversation_confirmation_tokens WHERE expires_at < ?',
    ).run(p.before);
    return { rowsAffected: result.changes };
  });
}
