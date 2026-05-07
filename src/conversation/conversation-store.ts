/**
 * 对话消息持久化（P1-C 生产级）
 *
 * 支持字段加密（FieldEncryption 注入；keyref 持久化便于跨密钥轮换查询），
 * 写入时透明加密，读取时透明解密。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  cmsgQueryByIdempotency, cmsgQueryListBySession, cmsgQueryCountBySession,
  cmsgCmdInsert, cmsgCmdDeleteByPersona, cmsgCmdPruneByRetention,
} from '@chrono/kernel';
import type { CmsgRow } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { FieldEncryption } from '../storage/encryption.js';
import type {
  CalibratedConfidence,
  ConversationMessage,
  GuardAction,
} from './conversation-types.js';

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
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly encryption?: FieldEncryption,
    private readonly encryptionKeyRef = 'master',
  ) {
    registerCoreSelfExecutors();
  }

  insert(input: InsertMessageInput): ConversationMessage {
    const now = Date.now();
    const userInputStored = this.encryption ? this.encryption.encrypt(input.userInput, this.encryptionKeyRef) : input.userInput;
    const assistantOutputStored = this.encryption ? this.encryption.encrypt(input.assistantOutput, this.encryptionKeyRef) : input.assistantOutput;
    const keyRef = this.encryption ? this.encryptionKeyRef : null;
    const memoriesUsedJson = JSON.stringify(input.memoriesUsed);
    const confidenceFactorsJson = JSON.stringify({
      level: input.confidence.level,
      interval: input.confidence.interval,
      factors: input.confidence.factors,
    });

    this.tx.execute(cmsgCmdInsert({
      id: input.id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      externalUserId: input.externalUserId,
      userInput: userInputStored,
      assistantOutput: assistantOutputStored,
      memoriesUsedJson,
      shouldEscalate: input.shouldEscalate ? 1 : 0,
      confidenceScore: input.confidence.score,
      confidenceFactorsJson,
      guardAction: input.guardAction,
      guardReason: input.guardReason,
      durationMs: input.durationMs,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      encryptionKeyRef: keyRef,
      inputRedactedPiiCount: input.inputRedactedPiiCount,
      outputRedactedPiiCount: input.outputRedactedPiiCount,
      retentionClass: input.retentionClass,
      now,
    }));

    return this.rowToMessage({
      id: input.id,
      tenant_id: input.tenantId,
      persona_id: input.personaId,
      session_id: input.sessionId,
      message_id: input.messageId,
      external_user_id: input.externalUserId,
      user_input: userInputStored,
      assistant_output: assistantOutputStored,
      memories_used_json: memoriesUsedJson,
      should_escalate: input.shouldEscalate ? 1 : 0,
      confidence_score: input.confidence.score,
      confidence_factors_json: confidenceFactorsJson,
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
    const row = this.tx.queryOne(cmsgQueryByIdempotency(input));
    return row ? this.rowToMessage(row) : null;
  }

  listBySession(input: {
    tenantId: string;
    personaId: string;
    sessionId: string;
    limit?: number;
  }): ConversationMessage[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.tx.queryMany(cmsgQueryListBySession({
      tenantId: input.tenantId, personaId: input.personaId, sessionId: input.sessionId, limit,
    }));
    return rows.map((r) => this.rowToMessage(r));
  }

  countBySession(input: { tenantId: string; personaId: string; sessionId: string }): number {
    const row = this.tx.queryOne(cmsgQueryCountBySession(input));
    return row?.n ?? 0;
  }

  /** GDPR：按 tenant + persona 删除全部对话（litigation_hold 受保护） */
  deleteByPersona(tenantId: string, personaId: string): number {
    const result = this.tx.execute(cmsgCmdDeleteByPersona({ tenantId, personaId }));
    return result.rowsAffected;
  }

  /** retention 清理：删除超过保留期且不在 hold 状态的消息 */
  pruneByRetention(input: { now: number; standardCutoffMs: number; extendedCutoffMs: number }): number {
    const standardCutoff = input.now - input.standardCutoffMs;
    const extendedCutoff = input.now - input.extendedCutoffMs;
    const result = this.tx.execute(cmsgCmdPruneByRetention({ standardCutoff, extendedCutoff }));
    return result.rowsAffected;
  }

  private rowToMessage(row: CmsgRow): ConversationMessage {
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
      } catch {
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
