/**
 * 对话流水线（P1-C 生产级）
 *
 * 9 步骤：
 *   1. 幂等检查
 *   2. 加载 persona profile（同时校验 owner）
 *   3. ValueGuard.preCheck（异步多层防御）
 *      - never_discuss → pre_block
 *      - always_escalate → 标注后继续
 *      - require_confirmation → 验证 confirmationToken；缺失则签发新 token 并返回
 *   4. PII 脱敏 + 配额检查 + 知识检索
 *   5. PromptBuilder 拼装
 *   6. 通过 CircuitBreaker + 重试调用 LLM；失败时降级到 fallback 模板
 *   7. ValueGuard.postCheck
 *   8. confidence 校准
 *   9. 持久化（加密） + 审计 + 指标
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { LLMProvider, ChatMessage } from '../intelligence/llm-provider.js';
import type { Logger } from '../utils/logger.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import type { FieldEncryption } from '../storage/encryption.js';
import type { TokenBudget } from '../intelligence/token-budget.js';
import type { QuotaManager } from '../multi-tenant/quota-manager.js';
import type { CostTracker } from '../intelligence/cost-tracker.js';
import type { UsageTracker } from '../billing/usage-tracker.js';
import type { BillingOutbox } from '../billing/billing-outbox.js';
import { CircuitBreaker, CircuitOpenError, CircuitTimeoutError } from '../server/plugins/circuit-breaker.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { ConversationStore } from './conversation-store.js';
import { ConversationKnowledgeRetriever } from './conversation-knowledge-retriever.js';
import { PersonaPromptBuilder } from './persona-prompt-builder.js';
import { OfflineConversationResponder } from './offline-conversation-responder.js';
import { ValueGuard, PRE_BLOCK_RESPONSE, NEEDS_CONFIRMATION_RESPONSE } from './value-guard.js';
import { ConfirmationTokenStore } from './confirmation-token-store.js';
import { ConversationAuditPublisher } from './audit-publisher.js';
import { calibrateConfidence } from './confidence-calibrator.js';
import { redactPii } from './pii-redactor.js';
import {
  toConversationResponse,
  type ConversationHistoryEntry,
  type ConversationMessage,
  type ConversationResponse,
  type GuardAction,
  type RelevantKnowledge,
} from './conversation-types.js';
import {
  conversationDurationMs,
  conversationLlmFailures,
  conversationMessagesTotal,
  conversationPiiRedacted,
  conversationQuotaExceeded,
} from '../observability/metrics.js';

export const DEFAULT_TOP_K = 5;
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TEMPERATURE = 0.5;
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
export const DEFAULT_LLM_RETRY_LIMIT = 2;
export const DEFAULT_LLM_RETRY_BACKOFF_MS = 500;
export const DEFAULT_QUOTA_RESOURCE = 'conversation_message';

export const FALLBACK_RESPONSE = '抱歉，当前服务遇到瞬时问题，已记录此请求并将由人工同事跟进。';
export const QUOTA_EXCEEDED_RESPONSE = '当前对话流量已达上限，请稍后重试或联系管理员。';

export interface ConversationServiceDeps {
  tx: SyncWriteUnitOfWork;
  /**
   * LLM 提供方。ADR-0047 D2：可省略以构造"无 cloud LLM 的对话 runtime"——
   * 此时每条消息直接走确定性离线回应（autonomous_response），不调用 LLM、
   * 不触发 circuit breaker / 失败指标。注入则为 growth 模式（LLM-first）。
   */
  llm?: LLMProvider;
  personaCoreService: PersonaCoreService;
  logger: Logger;
  encryption?: FieldEncryption;
  tokenBudget?: TokenBudget;
  quotaManager?: QuotaManager;
  costTracker?: CostTracker;
  /** P1-D：记录 conversation_message 用量到 usage_records（用于 SubscriptionGate 月度计算） */
  usageTracker?: UsageTracker;
  /** P1-D：异步推送 Stripe Meter Event */
  billingOutbox?: BillingOutbox;
  /** P1-D：用于查询订阅 stripe_customer_id 决定是否推送计量事件 */
  stripeCustomerLookup?: (tenantId: string) => string | null;
  circuitBreaker?: CircuitBreaker;
  guardOptions?: ConstructorParameters<typeof ValueGuard>[0];
  retrieverOptions?: ConstructorParameters<typeof ConversationKnowledgeRetriever>[1];
  llmTimeoutMs?: number;
  llmRetryLimit?: number;
  llmRetryBackoffMs?: number;
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
  /** 命中 require_confirmation 后再次提交需携带 token */
  confirmationToken?: string;
  /** retention 策略；默认 standard */
  retentionClass?: ConversationMessage['retentionClass'];
}

export class PersonaNotFoundForConversationError extends Error {
  constructor(personaId: string) {
    super(`persona ${personaId} not found or caller is not owner`);
    this.name = 'PersonaNotFoundForConversationError';
  }
}

export class ConversationLlmError extends Error {
  constructor(reason: string) {
    super(`LLM call failed: ${reason}`);
    this.name = 'ConversationLlmError';
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
  private readonly offlineResponder: OfflineConversationResponder;
  private readonly guard: ValueGuard;
  private readonly confirmationStore: ConfirmationTokenStore;
  private readonly auditPublisher: ConversationAuditPublisher;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly llmRetryLimit: number;
  private readonly llmRetryBackoffMs: number;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.store = new ConversationStore(deps.tx, deps.encryption);
    this.retriever = new ConversationKnowledgeRetriever(deps.tx, deps.retrieverOptions);
    this.promptBuilder = new PersonaPromptBuilder();
    this.guard = new ValueGuard({ ...deps.guardOptions, logger: deps.logger });
    /* 离线回应器复用 ValueGuard 的确定性 literalMatch，保证离线/在线边界规则同源 */
    this.offlineResponder = new OfflineConversationResponder(this.guard);
    this.confirmationStore = new ConfirmationTokenStore(deps.tx);
    this.auditPublisher = new ConversationAuditPublisher(deps.tx, deps.logger);
    this.circuitBreaker = deps.circuitBreaker ?? new CircuitBreaker({
      executionTimeoutMs: deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    });
    this.llmRetryLimit = deps.llmRetryLimit ?? DEFAULT_LLM_RETRY_LIMIT;
    this.llmRetryBackoffMs = deps.llmRetryBackoffMs ?? DEFAULT_LLM_RETRY_BACKOFF_MS;
  }

  getStore(): ConversationStore {
    return this.store;
  }

  getConfirmationStore(): ConfirmationTokenStore {
    return this.confirmationStore;
  }

  getRetriever(): ConversationKnowledgeRetriever {
    return this.retriever;
  }

  /** Health probe：当前 LLM 调用链 circuit breaker 状态 */
  getCircuitState(): 'closed' | 'open' | 'half_open' {
    return this.circuitBreaker.getState();
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
    if (existing) {
      this.recordMetric(existing.guardAction, Date.now() - startedAt);
      return toConversationResponse(existing);
    }

    /* Step 2: 加载 profile + owner 校验 */
    const profileBundle = this.loadProfile(input);

    /* Step 3: ValueGuard.preCheck */
    const preResult = await this.guard.preCheck(input.content, profileBundle.boundaries);

    if (preResult.action === 'pre_block') {
      const message = this.persistOutcome(input, {
        assistantOutput: PRE_BLOCK_RESPONSE,
        memoriesUsed: [],
        shouldEscalate: false,
        guardAction: 'pre_block',
        guardReason: preResult.reason ?? 'never_discuss matched',
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        llmFallback: false,
        quotaExceeded: false,
        retentionClass: input.retentionClass ?? 'standard',
      });
      return toConversationResponse(message);
    }

    if (preResult.action === 'needs_confirmation') {
      /* 加固 2：服务端拦截。若调用方已携带 token 验证通过则跳过此 block */
      if (input.confirmationToken) {
        const verify = this.confirmationStore.consume({
          token: input.confirmationToken,
          tenantId: input.tenantId,
          personaId: input.personaId,
          sessionId: input.sessionId,
          externalUserId: input.externalUserId,
          userInput: input.content,
        });
        if (verify.ok) {
          /* 通过：回到正常 LLM 路径，但保留 escalate 信号 */
          return this.continueAfterConfirmation(input, profileBundle, preResult.reason, startedAt);
        }
        /* token 校验失败 → 重新进入 needs_confirmation 流程并签发新 token */
        this.deps.logger.warn('ConversationService', `confirmationToken 校验失败: ${verify.reason}`);
      }
      const issued = this.confirmationStore.issue({
        tenantId: input.tenantId,
        personaId: input.personaId,
        sessionId: input.sessionId,
        externalUserId: input.externalUserId,
        topic: preResult.matchedTopic ?? 'unknown',
        rule: preResult.matchedRule ?? 'require_confirmation',
        userInput: input.content,
      });
      const message = this.persistOutcome(input, {
        assistantOutput: NEEDS_CONFIRMATION_RESPONSE,
        memoriesUsed: [],
        shouldEscalate: false,
        guardAction: 'needs_confirmation',
        guardReason: preResult.reason ?? 'require_confirmation matched',
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        llmFallback: false,
        quotaExceeded: false,
        retentionClass: input.retentionClass ?? 'standard',
      });
      return toConversationResponse(message, issued);
    }

    const escalateFromInput = preResult.action === 'escalate';

    /* Step 4: 配额检查 + PII 脱敏 + 知识检索 */
    const quotaCheck = this.checkQuota(input.tenantId);
    if (!quotaCheck.allowed) {
      const message = this.persistOutcome(input, {
        assistantOutput: QUOTA_EXCEEDED_RESPONSE,
        memoriesUsed: [],
        shouldEscalate: true,
        guardAction: 'quota_exceeded',
        guardReason: quotaCheck.reason ?? 'quota exceeded',
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        llmFallback: false,
        quotaExceeded: true,
        retentionClass: input.retentionClass ?? 'standard',
      });
      /* persistOutcome 内已 recordMetric，此处只补 quota 专项计数器，避免双计 */
      conversationQuotaExceeded.add(1, { tenant: input.tenantId });
      return toConversationResponse(message);
    }

    const sanitizedInputResult = redactPii(input.content);
    const sanitizedInput = sanitizedInputResult.text;
    if (sanitizedInputResult.redactedCount > 0) {
      conversationPiiRedacted.add(sanitizedInputResult.redactedCount, { side: 'input' });
    }

    const relevantKnowledge = await this.retriever.retrieve({
      tenantId: input.tenantId,
      personaId: input.personaId,
      userInput: input.content,  /* 检索可使用原文以提高召回 */
      topK: DEFAULT_TOP_K,
    });

    /* Step 5: prompt 拼装（user 内容已脱敏） */
    const promptParts = this.promptBuilder.build({
      narrative: profileBundle.narrative,
      boundaries: profileBundle.boundaries,
      relevantKnowledge,
      history: this.sanitizeHistory(input.history),
      userInput: sanitizedInput,
    });

    /* Step 6: LLM 调用（带 CB + 超时 + 重试 + fallback） */
    const llmResult = await this.callLlmWithResilience([
      { role: 'system', content: promptParts.system },
      ...promptParts.messages,
    ]);

    let assistantOutput = llmResult.content;
    let promptTokens = llmResult.promptTokens;
    let completionTokens = llmResult.completionTokens;
    const llmFallback = llmResult.fallback;

    /* Step 7: postCheck（或 ADR-0047 自主模式离线回应） */
    let guardAction: GuardAction = null;
    let guardReason: string | null = null;
    let autonomousEscalate = false;
    if (!llmFallback) {
      const postResult = await this.guard.postCheck(assistantOutput, profileBundle.boundaries);
      if (postResult.action === 'post_redact' && postResult.redactedContent) {
        assistantOutput = postResult.redactedContent;
        guardAction = 'post_redact';
        guardReason = postResult.reason ?? 'never_discuss leaked';
      }
    } else {
      /* ADR-0047：LLM 不可达时，由确定性离线回应器据人格 + 已检索知识生成回应，
       * 而非返回静态道歉。这是"自主模式"，非故障。 */
      const offline = this.offlineResponder.respond({
        narrative: profileBundle.narrative,
        boundaries: profileBundle.boundaries,
        userInput: sanitizedInput,
        relevantKnowledge,
        history: this.sanitizeHistory(input.history),
      });
      assistantOutput = offline.content;
      autonomousEscalate = offline.shouldEscalate;
      guardAction = 'autonomous_response';
      guardReason = `offline:${offline.kind} (llm ${llmResult.failureReason ?? 'unreachable'})`;
    }

    /* assistant 输出脱敏：避免 LLM 把用户 PII 反射回来 */
    const sanitizedOutput = redactPii(assistantOutput);
    assistantOutput = sanitizedOutput.text;
    if (sanitizedOutput.redactedCount > 0) {
      conversationPiiRedacted.add(sanitizedOutput.redactedCount, { side: 'output' });
    }

    if (escalateFromInput && guardAction === null) {
      guardAction = 'escalate';
      guardReason = preResult.reason ?? 'always_escalate matched';
    }

    /* 记 LLM 成本 + token budget */
    this.recordLlmTokenAccounting(input.tenantId, promptTokens, completionTokens);

    /* Step 8+9：持久化 + 审计 + 指标 */
    const message = this.persistOutcome(input, {
      assistantOutput,
      memoriesUsed: relevantKnowledge,
      shouldEscalate: escalateFromInput || guardAction === 'escalate' || autonomousEscalate,
      guardAction,
      guardReason,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      llmFallback,
      quotaExceeded: false,
      retentionClass: input.retentionClass ?? 'standard',
      sanitizedInputCount: sanitizedInputResult.redactedCount,
      sanitizedOutputCount: sanitizedOutput.redactedCount,
    });

    return toConversationResponse(message);
  }

  /**
   * 真流式提交：底层 provider 支持 chatStream 时按 token 流式发出；否则回退到 submit()
   * 后再分块。回调函数接收每个 delta；返回最终 response（含完整 assistantOutput）。
   *
   * 注意：流式仍走完整的 guard.preCheck → 检索 → prompt → guard.postCheck 流水线；
   * pre_block / needs_confirmation / quota_exceeded 命中时不进入流式，直接由 submit()
   * 返回完整响应（onDelta 不会被调用）。
   */
  async submitStream(
    input: SubmitMessageInput,
    onDelta: (delta: string) => void | Promise<void>,
  ): Promise<ConversationResponse> {
    /* 当前实现：直接 submit；后续可扩展为流式 LLM 拼装路径 */
    const response = await this.submit(input);
    if (response.guardAction === null || response.guardAction === 'escalate' || response.guardAction === 'post_redact' || response.guardAction === 'llm_fallback' || response.guardAction === 'autonomous_response') {
      const text = response.response;
      const CHUNK = 32;
      for (let i = 0; i < text.length; i += CHUNK) {
        const slice = text.slice(i, i + CHUNK);
        await onDelta(slice);
      }
    }
    return response;
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
      messages: messages.map((m) => toConversationResponse(m)),
      totalMessages,
    };
  }

  /** GDPR 删除接口 */
  deleteAllByPersona(tenantId: string, personaId: string): number {
    return this.store.deleteByPersona(tenantId, personaId);
  }

  /** retention 周期清理（由 worker 调用） */
  pruneByRetention(input: { now: number; standardCutoffMs: number; extendedCutoffMs: number }): number {
    return this.store.pruneByRetention(input);
  }

  private async continueAfterConfirmation(
    input: SubmitMessageInput,
    profileBundle: ProfileBundle,
    confirmationReason: string | undefined,
    startedAt: number,
  ): Promise<ConversationResponse> {
    /* 与主路径一致：确认后仍需配额检查（否则确认即可绕过 quota 交付并计费） */
    const quotaCheck = this.checkQuota(input.tenantId);
    if (!quotaCheck.allowed) {
      const message = this.persistOutcome(input, {
        assistantOutput: QUOTA_EXCEEDED_RESPONSE,
        memoriesUsed: [],
        shouldEscalate: true,
        guardAction: 'quota_exceeded',
        guardReason: quotaCheck.reason ?? 'quota exceeded',
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        llmFallback: false,
        quotaExceeded: true,
        retentionClass: input.retentionClass ?? 'standard',
      });
      /* 与主路径一致的 quota 专项计数器（recordMetric 已在 persistOutcome 内） */
      conversationQuotaExceeded.add(1, { tenant: input.tenantId });
      return toConversationResponse(message);
    }

    const sanitizedInputResult = redactPii(input.content);
    if (sanitizedInputResult.redactedCount > 0) {
      conversationPiiRedacted.add(sanitizedInputResult.redactedCount, { side: 'input' });
    }
    const relevantKnowledge = await this.retriever.retrieve({
      tenantId: input.tenantId,
      personaId: input.personaId,
      userInput: input.content,
      topK: DEFAULT_TOP_K,
    });
    const promptParts = this.promptBuilder.build({
      narrative: profileBundle.narrative,
      boundaries: profileBundle.boundaries,
      relevantKnowledge,
      history: this.sanitizeHistory(input.history),
      userInput: sanitizedInputResult.text,
    });
    const llmResult = await this.callLlmWithResilience([
      { role: 'system', content: promptParts.system },
      ...promptParts.messages,
    ]);
    const llmFallback = llmResult.fallback;
    let assistantOutput = llmResult.content;
    let guardAction: GuardAction = llmFallback ? 'autonomous_response' : 'escalate';
    let guardReason: string = confirmationReason ?? 'post-confirmation execution';
    /* ADR-0047：确认后路径同样在 LLM 不可达时走确定性离线回应，而非静态道歉。 */
    if (llmFallback) {
      const offline = this.offlineResponder.respond({
        narrative: profileBundle.narrative,
        boundaries: profileBundle.boundaries,
        userInput: sanitizedInputResult.text,
        relevantKnowledge,
        history: this.sanitizeHistory(input.history),
      });
      assistantOutput = offline.content;
    } else {
      /* LLM 成功：与主路径一致，必须跑 postCheck 防 never_discuss 泄露 */
      const postResult = await this.guard.postCheck(assistantOutput, profileBundle.boundaries);
      if (postResult.action === 'post_redact' && postResult.redactedContent) {
        assistantOutput = postResult.redactedContent;
        guardAction = 'post_redact';
        guardReason = postResult.reason ?? 'never_discuss leaked';
      }
    }
    /* 与主路径一致：记 LLM token 成本/budget（离线 fallback 时 token=0 自动跳过） */
    this.recordLlmTokenAccounting(input.tenantId, llmResult.promptTokens, llmResult.completionTokens);
    const sanitizedOutput = redactPii(assistantOutput);
    assistantOutput = sanitizedOutput.text;
    if (sanitizedOutput.redactedCount > 0) {
      conversationPiiRedacted.add(sanitizedOutput.redactedCount, { side: 'output' });
    }
    const message = this.persistOutcome(input, {
      assistantOutput,
      memoriesUsed: relevantKnowledge,
      shouldEscalate: true,
      guardAction,
      guardReason,
      durationMs: Date.now() - startedAt,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
      llmFallback,
      quotaExceeded: false,
      retentionClass: input.retentionClass ?? 'standard',
      sanitizedInputCount: sanitizedInputResult.redactedCount,
      sanitizedOutputCount: sanitizedOutput.redactedCount,
    });
    return toConversationResponse(message);
  }

  private async callLlmWithResilience(messages: ChatMessage[]): Promise<{
    content: string;
    promptTokens: number;
    completionTokens: number;
    fallback: boolean;
    failureReason?: string;
  }> {
    /* ADR-0047 D2：未配置 LLM → 直接进入自主模式，不调用 LLM、不污染 circuit breaker
     * 与失败指标。返回 fallback=true 让下游走 OfflineConversationResponder。 */
    if (!this.deps.llm) {
      return { content: '', promptTokens: 0, completionTokens: 0, fallback: true, failureReason: 'no_llm_configured' };
    }
    const llm = this.deps.llm;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.llmRetryLimit; attempt++) {
      try {
        const resp = await this.circuitBreaker.execute(async () =>
          llm.chat(messages, {
            temperature: DEFAULT_TEMPERATURE,
            maxTokens: DEFAULT_MAX_TOKENS,
          }),
        );
        return {
          content: resp.content,
          promptTokens: resp.usage?.inputTokens ?? 0,
          completionTokens: resp.usage?.outputTokens ?? 0,
          fallback: false,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const fatal = err instanceof CircuitOpenError;
        const transient = err instanceof CircuitTimeoutError || isTransientError(err);
        conversationLlmFailures.add(1, {
          reason: fatal ? 'circuit_open' : transient ? 'transient' : 'other',
          attempt: String(attempt),
        });
        if (fatal) break;
        if (!transient || attempt === this.llmRetryLimit) break;
        const backoff = this.llmRetryBackoffMs * Math.pow(2, attempt);
        this.deps.logger.warn('ConversationService', `LLM 调用失败 attempt=${attempt} 后退 ${backoff}ms: ${lastErr.message}`);
        await sleep(backoff);
      }
    }
    /* 全部失败 → 降级 */
    return {
      content: FALLBACK_RESPONSE,
      promptTokens: 0,
      completionTokens: 0,
      fallback: true,
      failureReason: lastErr?.message ?? 'unknown llm failure',
    };
  }

  private checkQuota(tenantId: string): { allowed: boolean; reason?: string } {
    /* TokenBudget 维度 */
    if (this.deps.tokenBudget) {
      const result = this.deps.tokenBudget.checkBudget(tenantId, DEFAULT_MAX_TOKENS);
      if (!result.allowed) {
        return { allowed: false, reason: `token budget: ${result.reason ?? 'exceeded'}` };
      }
    }
    /* QuotaManager 维度（按消息计数） */
    if (this.deps.quotaManager) {
      const ok = this.deps.quotaManager.consumeQuota(tenantId, DEFAULT_QUOTA_RESOURCE, 1);
      if (!ok) {
        return { allowed: false, reason: `quota: ${DEFAULT_QUOTA_RESOURCE} per-window exceeded` };
      }
    }
    return { allowed: true };
  }

  private sanitizeHistory(history?: ConversationHistoryEntry[]): ConversationHistoryEntry[] {
    if (!history || history.length === 0) return [];
    return history
      .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim().length > 0)
      .slice(-20)
      .map((h) => ({ role: h.role, content: redactPii(h.content.slice(0, 8000)).text }));
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

  private persistOutcome(
    input: SubmitMessageInput,
    outcome: {
      assistantOutput: string;
      memoriesUsed: RelevantKnowledge[];
      shouldEscalate: boolean;
      guardAction: GuardAction;
      guardReason: string | null;
      durationMs: number;
      promptTokens: number;
      completionTokens: number;
      llmFallback: boolean;
      quotaExceeded: boolean;
      retentionClass: ConversationMessage['retentionClass'];
      sanitizedInputCount?: number;
      sanitizedOutputCount?: number;
    },
  ): ConversationMessage {
    const id = generatePrefixedId('cmsg');
    const confidence = calibrateConfidence({
      memoriesUsed: outcome.memoriesUsed,
      guardAction: outcome.guardAction,
      shouldEscalate: outcome.shouldEscalate,
      llmFallback: outcome.llmFallback,
      quotaExceeded: outcome.quotaExceeded,
      completionTokens: outcome.completionTokens,
    });
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
      confidence,
      guardAction: outcome.guardAction,
      guardReason: outcome.guardReason,
      durationMs: outcome.durationMs,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      inputRedactedPiiCount: outcome.sanitizedInputCount ?? 0,
      outputRedactedPiiCount: outcome.sanitizedOutputCount ?? 0,
      retentionClass: outcome.retentionClass,
    });

    this.auditPublisher.publish({
      tenantId: input.tenantId,
      actorType: 'user',
      actorId: input.ownerUserId,
      actionType: actionTypeFor(outcome.guardAction, outcome.shouldEscalate),
      targetType: 'persona_core',
      targetId: input.personaId,
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        externalUserId: input.externalUserId,
        memoriesUsedCount: outcome.memoriesUsed.length,
        shouldEscalate: outcome.shouldEscalate,
        confidenceScore: confidence.score,
        confidenceLevel: confidence.level,
        guardAction: outcome.guardAction,
        guardReason: outcome.guardReason,
        durationMs: outcome.durationMs,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        inputRedactedPiiCount: outcome.sanitizedInputCount ?? 0,
        outputRedactedPiiCount: outcome.sanitizedOutputCount ?? 0,
        userMetadata: input.metadata ?? null,
      },
    });

    this.recordMetric(outcome.guardAction, outcome.durationMs);

    /* P1-D: 计费用量上报 —— 按"已交付一条 persona 消息"计费（pre_block /
     * needs_confirmation / quota_exceeded 未交付，不计费）。autonomous_response
     * （ADR-0047 离线回应）虽未消耗 LLM token，但仍是已交付消息，按 per-message
     * 口径计费，与 llm_fallback 一致。 */
    const billable = outcome.guardAction === null
      || outcome.guardAction === 'escalate'
      || outcome.guardAction === 'post_redact'
      || outcome.guardAction === 'llm_fallback'
      || outcome.guardAction === 'autonomous_response';
    if (billable) {
      this.recordBillableUsage(input.tenantId, 1);
    }

    return message;
  }

  private recordBillableUsage(tenantId: string, quantity: number): void {
    try {
      this.deps.usageTracker?.record(tenantId, 'conversation_message', quantity);
    } catch (err) {
      this.deps.logger.warn('ConversationService', `usage tracker record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.deps.billingOutbox && this.deps.stripeCustomerLookup) {
      try {
        const customerId = this.deps.stripeCustomerLookup(tenantId);
        if (customerId) {
          this.deps.billingOutbox.enqueue(tenantId, customerId, 'chrono_conversation_message', quantity);
        }
      } catch (err) {
        this.deps.logger.warn('ConversationService', `billing outbox enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private recordMetric(action: GuardAction, durationMs: number): void {
    conversationMessagesTotal.add(1, { guard_action: action ?? 'none' });
    conversationDurationMs.record(durationMs, { guard_action: action ?? 'none' });
  }

  /** 记录 LLM token 成本与 token budget 用量（主路径与确认后路径共用） */
  private recordLlmTokenAccounting(tenantId: string, promptTokens: number, completionTokens: number): void {
    const total = promptTokens + completionTokens;
    if (total <= 0) return;
    if (this.deps.costTracker) {
      try {
        this.deps.costTracker.record(tenantId, 'conversation', 'conversation', promptTokens, completionTokens);
      } catch (err) {
        this.deps.logger.warn('ConversationService', `cost recording failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.deps.tokenBudget) {
      try {
        this.deps.tokenBudget.recordUsage(tenantId, total);
      } catch (err) {
        this.deps.logger.warn('ConversationService', `token budget recording failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function actionTypeFor(guardAction: GuardAction, shouldEscalate: boolean): string {
  if (guardAction) return `persona_conversation.message.${guardAction}`;
  if (shouldEscalate) return 'persona_conversation.message.escalate';
  return 'persona_conversation.message';
}

function isValidBoundary(value: unknown): value is BehaviorBoundary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.rule === 'never_discuss' || v.rule === 'always_escalate' || v.rule === 'require_confirmation') &&
    typeof v.topic === 'string' && v.topic.length > 0
  );
}

function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('temporarily unavailable')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
