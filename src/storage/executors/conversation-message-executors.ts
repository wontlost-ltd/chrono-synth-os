/**
 * 对话消息持久化 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  CMSG_QUERY_BY_IDEMPOTENCY, CMSG_QUERY_LIST_BY_SESSION, CMSG_QUERY_COUNT_BY_SESSION,
  CMSG_CMD_INSERT, CMSG_CMD_DELETE_BY_PERSONA, CMSG_CMD_PRUNE_BY_RETENTION,
} from '@chrono/kernel';
import type {
  CmsgRow, CmsgIdempotencyParams, CmsgListParams, CmsgCountParams,
  CmsgInsertParams, CmsgDeleteByPersonaParams, CmsgPruneByRetentionParams,
} from '@chrono/kernel';

export function registerConversationMessageExecutors(): void {
  registerQuery<CmsgRow | null, CmsgIdempotencyParams>(CMSG_QUERY_BY_IDEMPOTENCY, (db, p) => {
    return db.prepare<CmsgRow>(
      `SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ? AND message_id = ?
        LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.sessionId, p.messageId) ?? null;
  });

  registerQuery<readonly CmsgRow[], CmsgListParams>(CMSG_QUERY_LIST_BY_SESSION, (db, p) => {
    return db.prepare<CmsgRow>(
      `SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    ).all(p.tenantId, p.personaId, p.sessionId, p.limit);
  });

  registerQuery<{ n: number } | null, CmsgCountParams>(CMSG_QUERY_COUNT_BY_SESSION, (db, p) => {
    return db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ?`,
    ).get(p.tenantId, p.personaId, p.sessionId) ?? null;
  });

  registerCommand<CmsgInsertParams>(CMSG_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO conversation_messages (
        id, tenant_id, persona_id, session_id, message_id, external_user_id,
        user_input, assistant_output, memories_used_json,
        should_escalate, confidence_score, confidence_factors_json,
        guard_action, guard_reason,
        duration_ms, prompt_tokens, completion_tokens,
        encryption_key_ref, input_redacted_pii_count, output_redacted_pii_count,
        retention_class, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.sessionId, p.messageId, p.externalUserId,
      p.userInput, p.assistantOutput, p.memoriesUsedJson,
      p.shouldEscalate, p.confidenceScore, p.confidenceFactorsJson,
      p.guardAction, p.guardReason,
      p.durationMs, p.promptTokens, p.completionTokens,
      p.encryptionKeyRef, p.inputRedactedPiiCount, p.outputRedactedPiiCount,
      p.retentionClass, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<CmsgDeleteByPersonaParams>(CMSG_CMD_DELETE_BY_PERSONA, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND retention_class != 'litigation_hold'`,
    ).run(p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<CmsgPruneByRetentionParams>(CMSG_CMD_PRUNE_BY_RETENTION, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM conversation_messages
        WHERE (retention_class = 'standard' AND created_at < ?)
           OR (retention_class = 'extended' AND created_at < ?)`,
    ).run(p.standardCutoff, p.extendedCutoff);
    return { rowsAffected: result.changes };
  });
}
