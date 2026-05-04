/**
 * 对话消息持久化（P1-C 生产级）
 *
 * 支持字段加密（FieldEncryption 注入；keyref 持久化便于跨密钥轮换查询），
 * 写入时透明加密，读取时透明解密。
 */

import type { IDatabase } from '../storage/database.js';
import { unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import type { FieldEncryption } from '../storage/encryption.js';
import type {
  CalibratedConfidence,
  ConversationMessage,
  GuardAction,
} from './conversation-types.js';

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
  confidence_factors_json: string;
  guard_action: string | null;
  guard_reason: string | null;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  encryption_key_ref: string | null;
  input_redacted_pii_count: number;
  output_redacted_pii_count: number;
  retention_class: 'standard' | 'extended' | 'litigation_hold';
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
  confidence: CalibratedConfidence;
  guardAction: GuardAction;
  guardReason: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  inputRedactedPiiCount: number;
  outputRedactedPiiCount: number;
  retentionClass: ConversationMessage['retentionClass'];
}

export class ConversationStore {
  private readonly db: IDatabase | null;

  constructor(
    uowOrDb: UowOrDb,
    private readonly encryption?: FieldEncryption,
    private readonly encryptionKeyRef = 'master',
  ) {
    this.db = unwrapDb(uowOrDb);
  }

  private requireDb(method: string): IDatabase {
    if (!this.db) {
      throw new Error(`ConversationStore.${method} requires IDatabase entrance`);
    }
    return this.db;
  }

  insert(input: InsertMessageInput): ConversationMessage {
    const now = Date.now();
    const userInputStored = this.encryption ? this.encryption.encrypt(input.userInput, this.encryptionKeyRef) : input.userInput;
    const assistantOutputStored = this.encryption ? this.encryption.encrypt(input.assistantOutput, this.encryptionKeyRef) : input.assistantOutput;
    const keyRef = this.encryption ? this.encryptionKeyRef : null;

    this.requireDb('insert').prepare<void>(
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
      input.id,
      input.tenantId,
      input.personaId,
      input.sessionId,
      input.messageId,
      input.externalUserId,
      userInputStored,
      assistantOutputStored,
      JSON.stringify(input.memoriesUsed),
      input.shouldEscalate ? 1 : 0,
      input.confidence.score,
      JSON.stringify({
        level: input.confidence.level,
        interval: input.confidence.interval,
        factors: input.confidence.factors,
      }),
      input.guardAction,
      input.guardReason,
      input.durationMs,
      input.promptTokens,
      input.completionTokens,
      keyRef,
      input.inputRedactedPiiCount,
      input.outputRedactedPiiCount,
      input.retentionClass,
      now,
    );

    return this.rowToMessage({
      id: input.id,
      tenant_id: input.tenantId,
      persona_id: input.personaId,
      session_id: input.sessionId,
      message_id: input.messageId,
      external_user_id: input.externalUserId,
      user_input: userInputStored,
      assistant_output: assistantOutputStored,
      memories_used_json: JSON.stringify(input.memoriesUsed),
      should_escalate: input.shouldEscalate ? 1 : 0,
      confidence_score: input.confidence.score,
      confidence_factors_json: JSON.stringify({
        level: input.confidence.level,
        interval: input.confidence.interval,
        factors: input.confidence.factors,
      }),
      guard_action: input.guardAction,
      guard_reason: input.guardReason,
      duration_ms: input.durationMs,
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      encryption_key_ref: keyRef,
      input_redacted_pii_count: input.inputRedactedPiiCount,
      output_redacted_pii_count: input.outputRedactedPiiCount,
      retention_class: input.retentionClass,
      created_at: now,
    });
  }

  findByIdempotencyKey(input: {
    tenantId: string;
    personaId: string;
    sessionId: string;
    messageId: string;
  }): ConversationMessage | null {
    const row = this.requireDb('findByIdempotencyKey').prepare<MessageRow>(
      `SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ? AND message_id = ?
        LIMIT 1`,
    ).get(input.tenantId, input.personaId, input.sessionId, input.messageId);
    return row ? this.rowToMessage(row) : null;
  }

  listBySession(input: {
    tenantId: string;
    personaId: string;
    sessionId: string;
    limit?: number;
  }): ConversationMessage[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.requireDb('listBySession').prepare<MessageRow>(
      `SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    ).all(input.tenantId, input.personaId, input.sessionId, limit);
    return rows.map((r) => this.rowToMessage(r));
  }

  countBySession(input: { tenantId: string; personaId: string; sessionId: string }): number {
    const row = this.requireDb('countBySession').prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND session_id = ?`,
    ).get(input.tenantId, input.personaId, input.sessionId);
    return row?.n ?? 0;
  }

  /** GDPR：按 tenant + persona 删除全部对话（litigation_hold 受保护） */
  deleteByPersona(tenantId: string, personaId: string): number {
    const result = this.requireDb('deleteByPersona').prepare<void>(
      `DELETE FROM conversation_messages
        WHERE tenant_id = ? AND persona_id = ? AND retention_class != 'litigation_hold'`,
    ).run(tenantId, personaId);
    return result.changes ?? 0;
  }

  /** retention 清理：删除超过保留期且不在 hold 状态的消息 */
  pruneByRetention(input: { now: number; standardCutoffMs: number; extendedCutoffMs: number }): number {
    const standardCutoff = input.now - input.standardCutoffMs;
    const extendedCutoff = input.now - input.extendedCutoffMs;
    const result = this.requireDb('pruneByRetention').prepare<void>(
      `DELETE FROM conversation_messages
        WHERE (retention_class = 'standard' AND created_at < ?)
           OR (retention_class = 'extended' AND created_at < ?)`,
    ).run(standardCutoff, extendedCutoff);
    return result.changes ?? 0;
  }

  private rowToMessage(row: MessageRow): ConversationMessage {
    let memoriesUsed: ConversationMessage['memoriesUsed'] = [];
    try {
      const parsed = JSON.parse(row.memories_used_json);
      if (Array.isArray(parsed)) memoriesUsed = parsed;
    } catch { /* default empty */ }

    let confidence: CalibratedConfidence;
    try {
      const parsed = JSON.parse(row.confidence_factors_json);
      confidence = {
        score: row.confidence_score,
        level: parsed.level ?? 'medium',
        interval: parsed.interval ?? { lower: row.confidence_score - 0.1, upper: row.confidence_score + 0.1 },
        factors: Array.isArray(parsed.factors) ? parsed.factors : [],
      };
    } catch {
      confidence = {
        score: row.confidence_score,
        level: 'medium',
        interval: { lower: Math.max(0, row.confidence_score - 0.1), upper: Math.min(1, row.confidence_score + 0.1) },
        factors: [],
      };
    }

    let userInput = row.user_input;
    let assistantOutput = row.assistant_output;
    if (this.encryption && row.encryption_key_ref) {
      try {
        userInput = this.encryption.decrypt(row.user_input);
        assistantOutput = this.encryption.decrypt(row.assistant_output);
      } catch (err) {
        /* 解密失败：保留密文形态而非崩溃；上层检测到密文形态可决定是否告警 */
        userInput = row.user_input;
        assistantOutput = row.assistant_output;
      }
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      personaId: row.persona_id,
      sessionId: row.session_id,
      messageId: row.message_id,
      externalUserId: row.external_user_id,
      userInput,
      assistantOutput,
      memoriesUsed,
      shouldEscalate: row.should_escalate === 1,
      confidence,
      guardAction: (row.guard_action ?? null) as GuardAction,
      guardReason: row.guard_reason,
      durationMs: row.duration_ms,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      encryptionKeyRef: row.encryption_key_ref,
      inputRedactedPiiCount: row.input_redacted_pii_count,
      outputRedactedPiiCount: row.output_redacted_pii_count,
      retentionClass: row.retention_class,
      createdAt: row.created_at,
    };
  }
}
