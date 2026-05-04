/**
 * 对话消息持久化（P1-C）
 *
 * conversation_messages 表 CRUD，支持幂等查询、分页列表、tenant 隔离。
 * 不进入 TenantDatabase 自动重写；调用方显式带 tenant_id 条件。
 */

import type { IDatabase } from '../storage/database.js';
import type { ConversationMessage, GuardAction } from './conversation-types.js';

interface MessageRow {
  id: string;
  tenant_id: string;
  persona_id: string;
  session_id: string;
  message_id: string;
  external_user_id: string;
  user_input: string;
  assistant_output: string;
  memories_used_json: string;
  should_escalate: number;
  confidence_score: number;
  guard_action: string | null;
  guard_reason: string | null;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: number;
}

export interface InsertMessageInput {
  id: string;
  tenantId: string;
  personaId: string;
  sessionId: string;
  messageId: string;
  externalUserId: string;
  userInput: string;
  assistantOutput: string;
  memoriesUsed: ConversationMessage['memoriesUsed'];
  shouldEscalate: boolean;
  confidenceScore: number;
  guardAction: GuardAction;
  guardReason: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

export class ConversationStore {
  constructor(private readonly db: IDatabase) {}

  insert(input: InsertMessageInput): ConversationMessage {
    const now = Date.now();
    this.db.prepare<void>(
      `INSERT INTO conversation_messages (
        id, tenant_id, persona_id, session_id, message_id, external_user_id,
        user_input, assistant_output, memories_used_json,
        should_escalate, confidence_score,
        guard_action, guard_reason,
        duration_ms, prompt_tokens, completion_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.tenantId,
      input.personaId,
      input.sessionId,
      input.messageId,
      input.externalUserId,
      input.userInput,
      input.assistantOutput,
      JSON.stringify(input.memoriesUsed),
      input.shouldEscalate ? 1 : 0,
      input.confidenceScore,
      input.guardAction,
      input.guardReason,
      input.durationMs,
      input.promptTokens,
      input.completionTokens,
      now,
    );
    return rowToMessage({
      id: input.id,
      tenant_id: input.tenantId,
      persona_id: input.personaId,
      session_id: input.sessionId,
      message_id: input.messageId,
      external_user_id: input.externalUserId,
      user_input: input.userInput,
      assistant_output: input.assistantOutput,
      memories_used_json: JSON.stringify(input.memoriesUsed),
      should_escalate: input.shouldEscalate ? 1 : 0,
      confidence_score: input.confidenceScore,
      guard_action: input.guardAction,
      guard_reason: input.guardReason,
      duration_ms: input.durationMs,
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      created_at: now,
    });
  }

  /** 幂等查询：相同 (tenantId, personaId, sessionId, messageId) 返回已有消息 */
  findByIdempotencyKey(input: {
    tenantId: string;
    personaId: string;
    sessionId: string;
    messageId: string;
  }): ConversationMessage | null {
    const row = this.db.prepare<MessageRow>(
      `SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ? AND message_id = ?
        LIMIT 1`,
    ).get(input.tenantId, input.personaId, input.sessionId, input.messageId);
    return row ? rowToMessage(row) : null;
  }

  listBySession(input: {
    tenantId: string;
    personaId: string;
    sessionId: string;
    limit?: number;
  }): ConversationMessage[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.db.prepare<MessageRow>(
      `SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    ).all(input.tenantId, input.personaId, input.sessionId, limit);
    return rows.map(rowToMessage);
  }

  countBySession(input: { tenantId: string; personaId: string; sessionId: string }): number {
    const row = this.db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ?`,
    ).get(input.tenantId, input.personaId, input.sessionId);
    return row?.n ?? 0;
  }
}

function rowToMessage(row: MessageRow): ConversationMessage {
  let memoriesUsed: ConversationMessage['memoriesUsed'] = [];
  try {
    const parsed = JSON.parse(row.memories_used_json);
    if (Array.isArray(parsed)) memoriesUsed = parsed;
  } catch { /* default empty */ }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    externalUserId: row.external_user_id,
    userInput: row.user_input,
    assistantOutput: row.assistant_output,
    memoriesUsed,
    shouldEscalate: row.should_escalate === 1,
    confidenceScore: row.confidence_score,
    guardAction: (row.guard_action ?? null) as GuardAction,
    guardReason: row.guard_reason,
    durationMs: row.duration_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    createdAt: row.created_at,
  };
}
