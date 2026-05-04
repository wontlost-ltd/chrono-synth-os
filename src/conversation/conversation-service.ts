/**
 * 对话流水线（P1-C 9 步骤）
 *
 *   1. 幂等检查：(tenantId, personaId, sessionId, messageId) 已存在则直接返回
 *   2. 加载 persona profile（含 templateId, narrative, behaviorBoundaries）
 *   3. ValueGuard.preCheck：never_discuss 命中→pre_block；always_escalate→标注
 *   4. 检索相关知识（关键词匹配）
 *   5. PersonaPromptBuilder 拼装 system + user history + user input
 *   6. ModelRouter.chat 调用 LLM
 *   7. ValueGuard.postCheck：LLM 输出泄露 never_discuss 主题→重写
 *   8. 计算 confidenceScore
 *   9. 写 conversation_messages + recordBusinessAuditLog
 */

import type { IDatabase } from '../storage/database.js';
import type { LLMProvider, ChatMessage } from '../intelligence/llm-provider.js';
import type { Logger } from '../utils/logger.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { ConversationStore } from './conversation-store.js';
import { ConversationKnowledgeRetriever } from './conversation-knowledge-retriever.js';
import { PersonaPromptBuilder } from './persona-prompt-builder.js';
import { ValueGuard, PRE_BLOCK_RESPONSE } from './value-guard.js';
import {
  toConversationResponse,
  type ConversationHistoryEntry,
  type ConversationResponse,
  type GuardAction,
  type RelevantKnowledge,
} from './conversation-types.js';

export const DEFAULT_TOP_K = 5;
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TEMPERATURE = 0.5;

export interface ConversationServiceDeps {
  db: IDatabase;
  llm: LLMProvider;
  personaCoreService: PersonaCoreService;
  logger: Logger;
}

export interface SubmitMessageInput {
  tenantId: string;
  personaId: string;
  ownerUserId: string;
  sessionId: string;
  messageId: string;
  externalUserId: string;
  content: string;
  history?: ConversationHistoryEntry[];
  metadata?: Record<string, string>;
}

export class PersonaNotFoundForConversationError extends Error {
  constructor(personaId: string) {
    super(`persona ${personaId} not found or caller is not owner`);
    this.name = 'PersonaNotFoundForConversationError';
  }
}

interface ProfileBundle {
  narrative: string;
  boundaries: BehaviorBoundary[];
}

export class ConversationService {
  private readonly store: ConversationStore;
  private readonly retriever: ConversationKnowledgeRetriever;
  private readonly promptBuilder: PersonaPromptBuilder;
  private readonly guard: ValueGuard;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.store = new ConversationStore(deps.db);
    this.retriever = new ConversationKnowledgeRetriever(deps.db);
    this.promptBuilder = new PersonaPromptBuilder();
    this.guard = new ValueGuard();
  }

  getStore(): ConversationStore {
    return this.store;
  }

  async submit(input: SubmitMessageInput): Promise<ConversationResponse> {
    const startedAt = Date.now();

    /* Step 1: 幂等检查 */
    const existing = this.store.findByIdempotencyKey({
      tenantId: input.tenantId,
      personaId: input.personaId,
      sessionId: input.sessionId,
      messageId: input.messageId,
    });
    if (existing) return toConversationResponse(existing);

    /* Step 2: 加载 persona profile（同时校验调用者是 owner） */
    const profileBundle = this.loadProfile(input);

    /* Step 3: ValueGuard.preCheck */
    const preResult = this.guard.preCheck(input.content, profileBundle.boundaries);
    if (preResult.action === 'pre_block') {
      const message = this.persistAndAudit(input, {
        assistantOutput: PRE_BLOCK_RESPONSE,
        memoriesUsed: [],
        shouldEscalate: false,
        confidenceScore: 0.2,
        guardAction: 'pre_block',
        guardReason: preResult.reason ?? 'never_discuss matched',
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
      });
      return toConversationResponse(message);
    }
    const escalateFromInput = preResult.action === 'escalate';

    /* Step 4: 检索相关知识 */
    const relevantKnowledge = this.retriever.retrieve({
      tenantId: input.tenantId,
      personaId: input.personaId,
      userInput: input.content,
      topK: DEFAULT_TOP_K,
    });

    /* Step 5: 拼装 prompt */
    const promptParts = this.promptBuilder.build({
      narrative: profileBundle.narrative,
      boundaries: profileBundle.boundaries,
      relevantKnowledge,
      history: this.sanitizeHistory(input.history),
      userInput: input.content,
    });

    /* Step 6: LLM 调用 */
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: promptParts.system },
      ...promptParts.messages,
    ];
    let assistantOutput: string;
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      const resp = await this.deps.llm.chat(chatMessages, {
        temperature: DEFAULT_TEMPERATURE,
        maxTokens: DEFAULT_MAX_TOKENS,
      });
      assistantOutput = resp.content;
      promptTokens = resp.usage?.inputTokens ?? 0;
      completionTokens = resp.usage?.outputTokens ?? 0;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('ConversationService', `LLM 调用失败: ${reason}`);
      throw new ConversationLlmError(reason);
    }

    /* Step 7: ValueGuard.postCheck */
    const postResult = this.guard.postCheck(assistantOutput, profileBundle.boundaries);
    let guardAction: GuardAction = null;
    let guardReason: string | null = null;
    if (postResult.action === 'post_redact' && postResult.redactedContent) {
      assistantOutput = postResult.redactedContent;
      guardAction = 'post_redact';
      guardReason = postResult.reason ?? 'never_discuss leaked';
    } else if (escalateFromInput) {
      guardAction = 'escalate';
      guardReason = preResult.reason ?? 'always_escalate matched';
    }

    /* Step 8: 计算 confidenceScore */
    const confidenceScore = computeConfidence({
      memoriesUsed: relevantKnowledge,
      guardAction,
      escalate: escalateFromInput,
    });

    /* Step 9: 持久化 + 审计 */
    const message = this.persistAndAudit(input, {
      assistantOutput,
      memoriesUsed: relevantKnowledge,
      shouldEscalate: escalateFromInput,
      confidenceScore,
      guardAction,
      guardReason,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
    });

    return toConversationResponse(message);
  }

  listSession(input: {
    tenantId: string;
    personaId: string;
    sessionId: string;
    limit?: number;
  }): { messages: ConversationResponse[]; totalMessages: number } {
    const messages = this.store.listBySession(input);
    const totalMessages = this.store.countBySession(input);
    return {
      messages: messages.map(toConversationResponse),
      totalMessages,
    };
  }

  /** 调用方传入的 history 防御：去除非法 role、空字符串、过长的项 */
  private sanitizeHistory(history?: ConversationHistoryEntry[]): ConversationHistoryEntry[] {
    if (!history || history.length === 0) return [];
    return history
      .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim().length > 0)
      .slice(-20)
      .map((h) => ({ role: h.role, content: h.content.slice(0, 8000) }));
  }

  private loadProfile(input: SubmitMessageInput): ProfileBundle {
    const detail = this.deps.personaCoreService.getPersonaDetail(
      input.tenantId,
      input.ownerUserId,
      input.personaId,
    );
    if (!detail) throw new PersonaNotFoundForConversationError(input.personaId);

    const profile = (detail.profile ?? {}) as Record<string, unknown>;
    const narrative = typeof profile.narrative === 'string' ? profile.narrative : '';
    const boundaries = Array.isArray(profile.behaviorBoundaries)
      ? (profile.behaviorBoundaries as BehaviorBoundary[]).filter(isValidBoundary)
      : [];
    return { narrative, boundaries };
  }

  private persistAndAudit(
    input: SubmitMessageInput,
    outcome: {
      assistantOutput: string;
      memoriesUsed: RelevantKnowledge[];
      shouldEscalate: boolean;
      confidenceScore: number;
      guardAction: GuardAction;
      guardReason: string | null;
      durationMs: number;
      promptTokens: number;
      completionTokens: number;
    },
  ): ReturnType<ConversationStore['insert']> {
    const id = generatePrefixedId('cmsg');
    const message = this.store.insert({
      id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      externalUserId: input.externalUserId,
      userInput: input.content,
      assistantOutput: outcome.assistantOutput,
      memoriesUsed: outcome.memoriesUsed.map((m) => ({ id: m.id, title: m.title, relevance: m.relevance })),
      shouldEscalate: outcome.shouldEscalate,
      confidenceScore: outcome.confidenceScore,
      guardAction: outcome.guardAction,
      guardReason: outcome.guardReason,
      durationMs: outcome.durationMs,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
    });

    recordBusinessAuditLog(this.deps.db, {
      tenantId: input.tenantId,
      actorType: 'user',
      actorId: input.ownerUserId,
      actionType: outcome.guardAction
        ? `persona_conversation.message.${outcome.guardAction}`
        : outcome.shouldEscalate
          ? 'persona_conversation.message.escalate'
          : 'persona_conversation.message',
      targetType: 'persona_core',
      targetId: input.personaId,
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        externalUserId: input.externalUserId,
        memoriesUsedCount: outcome.memoriesUsed.length,
        shouldEscalate: outcome.shouldEscalate,
        confidenceScore: outcome.confidenceScore,
        guardAction: outcome.guardAction,
        guardReason: outcome.guardReason,
        durationMs: outcome.durationMs,
        userMetadata: input.metadata ?? null,
      },
    });

    return message;
  }
}

export class ConversationLlmError extends Error {
  constructor(reason: string) {
    super(`LLM call failed: ${reason}`);
    this.name = 'ConversationLlmError';
  }
}

function computeConfidence(input: {
  memoriesUsed: RelevantKnowledge[];
  guardAction: GuardAction;
  escalate: boolean;
}): number {
  const knowledgeBoost = 0.4 * Math.min(1, input.memoriesUsed.length / 3);
  const penalty = input.guardAction === 'post_redact' ? 0.3 : input.escalate ? 0.15 : 0;
  const raw = 0.5 + knowledgeBoost - penalty;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return Math.round(raw * 1000) / 1000;
}

function isValidBoundary(value: unknown): value is BehaviorBoundary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.rule === 'never_discuss' || v.rule === 'always_escalate' || v.rule === 'require_confirmation') &&
    typeof v.topic === 'string' && v.topic.length > 0
  );
}
