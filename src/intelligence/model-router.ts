/**
 * LLM Provider 路由器
 * 统一路由到 OpenAI / Anthropic / Ollama / Mock 后端
 * 内置重试、超时和提供商特定协议适配
 */

import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider, LLMProviderName } from './llm-provider.js';
import type { TokenBudget } from './token-budget.js';
import type { CostTracker } from './cost-tracker.js';
import type { QuotaManager } from '../multi-tenant/quota-manager.js';
import type { UsageTracker } from '../billing/usage-tracker.js';
import type { AppConfig } from '../config/schema.js';
import type { BillingOutbox } from '../billing/billing-outbox.js';
import { billingMetrics } from '../billing/billing-outbox.js';
import { QuotaExceededError, ValidationError } from '../errors/index.js';
import { checkInputSafety, validateOutput } from './llm-safety.js';
import { reportUsage as reportStripeUsage } from '../billing/stripe-client.js';

/** LLM 调用指标（用于可观测性） */
export const llmMetrics = {
  chatCalls: 0,
  chatErrors: 0,
  chatLatencyMs: [] as number[],
  embedCalls: 0,
  embedErrors: 0,
  embedLatencyMs: [] as number[],
  totalTokensConsumed: 0,
  /** ADR-0047 D2：降级链命中次数（主 provider 不可用→降级到下一档的次数）。 */
  fallbacks: 0,
};

/**
 * 是否「可用性失败」（应触发降级）。ADR-0047 D2：
 * 网络/超时/5xx/能力缺失（如 anthropic 无 embed）= 可用性失败 → 降级到下一档。
 * 但**主动拒绝**不算——安全拒绝（ValidationError）与预算·配额耗尽（QuotaExceededError）是有意
 * 结果，换 provider 也该被拒，降级反而绕过策略，故这两类直接抛出不降级。
 */
function isAvailabilityError(err: unknown): boolean {
  if (err instanceof ValidationError) return false;
  if (err instanceof QuotaExceededError) return false;
  return true;
}

const LLM_LATENCY_SAMPLES = 1024;

function recordLlmLatency(arr: number[], ms: number): void {
  if (arr.length >= LLM_LATENCY_SAMPLES) arr.shift();
  arr.push(ms);
}

/**
 * 降级链中的一档 provider 规格（ADR-0047 D2）。每一档自带 provider/model/凭据/端点——
 * 云端档用云 key+url，本地档（ollama）用本地 url+本地模型，互不共享凭据。
 */
export interface FallbackSpec {
  readonly provider: LLMProviderName;
  readonly model: string;
  readonly embeddingModel?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface ModelRouterConfig {
  readonly provider: LLMProviderName;
  readonly model: string;
  readonly embeddingModel: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /**
   * 自动分层降级链（ADR-0047 D2）：主 provider 因**可用性失败**（网络/超时/5xx）时，
   * 按顺序尝试下一档（典型：[云端 anthropic] → fallbacks:[本地 ollama]）。
   * **不**在「主动拒绝」（安全拒绝 / 预算·配额耗尽）时降级——那是有意拒绝，不是不可用。
   * 安全检查与预算·配额只在主路径消费一次，不随降级重复扣。
   * 全链失败 → 抛错，由调用方落到确定性档（decision-engine→RuleEngine /
   * offline-conversation-responder），这一档不在 ModelRouter 内。
   */
  readonly fallbacks?: readonly FallbackSpec[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly tokenBudget?: TokenBudget;
  readonly costTracker?: CostTracker;
  readonly quotaManager?: QuotaManager;
  readonly usageTracker?: UsageTracker;
  readonly tenantId?: string;
  readonly stripeConfig?: AppConfig;
  readonly stripeCustomerId?: string;
  readonly billingOutbox?: BillingOutbox;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Anthropic API 将 system 消息从 messages 数组中分离 */
function splitSystemMessages(messages: readonly ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
    } else {
      conversation.push({ role: msg.role, content: msg.content });
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: conversation,
  };
}

/** 简易确定性哈希向量，mock 模式用 */
function hashVector(text: string, size = 8): number[] {
  const vec = new Array(size).fill(0) as number[];
  for (let i = 0; i < text.length; i++) {
    vec[i % size] += text.charCodeAt(i) / 255;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

export class ModelRouter implements LLMProvider {
  private readonly provider: LLMProviderName;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly tokenBudget?: TokenBudget;
  private readonly costTracker?: CostTracker;
  private readonly quotaManager?: QuotaManager;
  private readonly usageTracker?: UsageTracker;
  private readonly tenantId: string;
  private readonly stripeConfig?: AppConfig;
  private readonly stripeCustomerId?: string;
  private readonly billingOutbox?: BillingOutbox;
  /**
   * 降级链子路由器（ADR-0047 D2）。每档一个**精简** ModelRouter：仅承担 provider 调度
   * （chat/embed 的 switch），不带 budget/quota/billing——那些只在主路由消费一次，子路由
   * 不重复扣。子路由自身 fallbacks 为空，避免递归链。
   */
  private readonly fallbackRouters: readonly ModelRouter[];

  constructor(config: ModelRouterConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.embeddingModel = config.embeddingModel;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenBudget = config.tokenBudget;
    this.costTracker = config.costTracker;
    this.quotaManager = config.quotaManager;
    this.usageTracker = config.usageTracker;
    this.tenantId = config.tenantId ?? 'default';
    this.stripeConfig = config.stripeConfig;
    this.stripeCustomerId = config.stripeCustomerId;
    this.billingOutbox = config.billingOutbox;
    /* 为每档 fallback 建一个精简子路由（无 budget/quota/billing/fallbacks，避免重复扣与递归）。
     * 子路由沿用主路由的 maxTokens/temperature/timeout（除非 spec 覆盖 model/凭据/端点）。 */
    this.fallbackRouters = (config.fallbacks ?? []).map((spec) => new ModelRouter({
      provider: spec.provider,
      model: spec.model,
      embeddingModel: spec.embeddingModel ?? config.embeddingModel,
      apiKey: spec.apiKey,
      baseUrl: spec.baseUrl,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      tenantId: config.tenantId,
    }));
  }

  async chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const estimatedTokens = options?.maxTokens ?? this.maxTokens;

    /* 安全检查：提示注入检测（mock 模式跳过，避免影响测试） */
    if (this.provider !== 'mock') {
      const safetyCheck = checkInputSafety(messages);
      if (!safetyCheck.safe) {
        throw new ValidationError(
          `LLM 安全策略拒绝: ${safetyCheck.reason}`,
        );
      }
    }

    /* 预检查 token 预算（先于配额消费，避免 budget 拒绝后浪费配额） */
    if (this.tokenBudget) {
      const check = this.tokenBudget.checkBudget(this.tenantId, estimatedTokens);
      if (!check.allowed) {
        throw new QuotaExceededError(`Token 预算不足: ${check.reason}`);
      }
    }

    /* 原子性配额预消费（按预估 token 数量） */
    if (this.quotaManager && !this.quotaManager.consumeQuota(this.tenantId, 'llm_tokens', estimatedTokens)) {
      throw new QuotaExceededError('LLM token 配额已用尽，请升级计划');
    }

    let response: ChatResponse;
    const chatStart = performance.now();
    llmMetrics.chatCalls++;
    try {
      /* ADR-0047 D2：沿降级链 [主, ...fallbacks] 尝试，仅可用性失败时降级（见 dispatchWithFallback）。 */
      response = await this.dispatchWithFallback(
        (r) => r.dispatchChatOnce(messages, options),
      );
    } catch (err) {
      llmMetrics.chatErrors++;
      recordLlmLatency(llmMetrics.chatLatencyMs, performance.now() - chatStart);
      throw err;
    }
    recordLlmLatency(llmMetrics.chatLatencyMs, performance.now() - chatStart);

    /* 输出安全验证：清理敏感信息泄露 */
    if (this.provider !== 'mock') {
      response = validateOutput(response);
    }

    /* 记录成本 */
    if (this.costTracker) {
      this.costTracker.record(
        this.tenantId,
        this.provider,
        this.model,
        response.usage?.inputTokens ?? 0,
        response.usage?.outputTokens ?? 0,
      );
    }

    const totalTokens = response.usage?.totalTokens ?? 0;
    if (totalTokens > 0) llmMetrics.totalTokensConsumed += totalTokens;
    if (this.tokenBudget && totalTokens > 0) {
      this.tokenBudget.recordUsage(this.tenantId, totalTokens);
    }
    if (this.usageTracker && totalTokens > 0) {
      this.usageTracker.record(this.tenantId, 'llm_tokens', totalTokens);
    }

    /* Stripe 计量上报 */
    if (this.stripeConfig?.stripe.enabled && this.stripeCustomerId && totalTokens > 0) {
      billingMetrics.meterEventsEnqueued++;
      if (this.billingOutbox) {
        this.billingOutbox.enqueue(this.tenantId, this.stripeCustomerId, 'llm_tokens', totalTokens);
      } else {
        reportStripeUsage(this.stripeConfig, this.stripeCustomerId, 'llm_tokens', totalTokens).then(() => {
          billingMetrics.meterEventsProcessed++;
        }).catch((e) => {
          console.error('[ModelRouter] Stripe 计量上报失败:', e instanceof Error ? e.message : String(e));
          billingMetrics.meterEventsFailed++;
        });
      }
    }

    return response;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    /* 粗略估算 token 量（~4 字符 / token） */
    let estimatedTokens = 0;
    for (const t of texts) estimatedTokens += Math.ceil(t.length / 4);

    if (this.tokenBudget) {
      const check = this.tokenBudget.checkBudget(this.tenantId, estimatedTokens);
      if (!check.allowed) throw new QuotaExceededError(`Token 预算不足: ${check.reason}`);
    }

    /* 原子性配额预消费 */
    if (this.quotaManager && !this.quotaManager.consumeQuota(this.tenantId, 'llm_tokens', estimatedTokens)) {
      throw new QuotaExceededError('LLM token 配额已用尽，请升级计划');
    }

    let embeddings: number[][];
    const embedStart = performance.now();
    llmMetrics.embedCalls++;
    try {
      /* ADR-0047 D2：embed 同样沿降级链。anthropic 无 embed 能力会抛错→降级到有 embed 的下一档
       * （如 ollama），这正是分层降级要解决的「主 provider 此能力不可用」。 */
      embeddings = await this.dispatchWithFallback((r) => r.dispatchEmbedOnce(texts));
    } catch (err) {
      llmMetrics.embedErrors++;
      recordLlmLatency(llmMetrics.embedLatencyMs, performance.now() - embedStart);
      throw err;
    }
    recordLlmLatency(llmMetrics.embedLatencyMs, performance.now() - embedStart);

    if (this.costTracker) {
      this.costTracker.record(this.tenantId, this.provider, this.embeddingModel, estimatedTokens, 0);
    }
    if (this.tokenBudget) this.tokenBudget.recordUsage(this.tenantId, estimatedTokens);
    if (estimatedTokens > 0) llmMetrics.totalTokensConsumed += estimatedTokens;
    if (this.usageTracker && estimatedTokens > 0) {
      this.usageTracker.record(this.tenantId, 'llm_tokens', estimatedTokens);
    }

    /* Stripe 计量上报 */
    if (this.stripeConfig?.stripe.enabled && this.stripeCustomerId && estimatedTokens > 0) {
      billingMetrics.meterEventsEnqueued++;
      if (this.billingOutbox) {
        this.billingOutbox.enqueue(this.tenantId, this.stripeCustomerId, 'llm_tokens', estimatedTokens);
      } else {
        reportStripeUsage(this.stripeConfig, this.stripeCustomerId, 'llm_tokens', estimatedTokens).then(() => {
          billingMetrics.meterEventsProcessed++;
        }).catch((e) => {
          console.error('[ModelRouter] Stripe 计量上报失败:', e instanceof Error ? e.message : String(e));
          billingMetrics.meterEventsFailed++;
        });
      }
    }

    return embeddings;
  }

  /* ─────────────── ADR-0047 D2：分层降级链 ─────────────── */

  /**
   * 沿降级链 [this, ...fallbackRouters] 依次尝试 op，仅在**可用性失败**时降级到下一档；
   * **主动拒绝**（安全拒绝 / 预算·配额耗尽）立即抛出，不降级（那是有意拒绝，非不可用）。
   * 全链失败抛最后一个错误，由调用方落到确定性档。
   */
  private async dispatchWithFallback<T>(op: (router: ModelRouter) => Promise<T>): Promise<T> {
    const chain: readonly ModelRouter[] = [this, ...this.fallbackRouters];
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      try {
        return await op(chain[i]);
      } catch (err) {
        lastErr = err;
        /* 主动拒绝不降级：安全拒绝 / 预算·配额耗尽是有意结果，换 provider 也该拒。 */
        if (!isAvailabilityError(err)) throw err;
        /* 可用性失败且还有下一档 → 记一次降级并继续；否则下面抛出。 */
        if (i < chain.length - 1) {
          llmMetrics.fallbacks++;
        }
      }
    }
    throw lastErr;
  }

  /** 纯 provider 调度（chat）：无 budget/safety/billing，仅 switch。供降级链每档调用。 */
  private async dispatchChatOnce(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    switch (this.provider) {
      case 'openai': return this.chatOpenAI(messages, options);
      case 'anthropic': return this.chatAnthropic(messages, options);
      case 'ollama': return this.chatOllama(messages, options);
      case 'mock': return this.chatMock(messages, options);
      default: throw new Error(`不支持的 LLM 提供商: ${this.provider}`);
    }
  }

  /** 纯 provider 调度（embed）。anthropic 无 embed 能力，抛错触发降级。 */
  private async dispatchEmbedOnce(texts: readonly string[]): Promise<number[][]> {
    switch (this.provider) {
      case 'openai': return this.embedOpenAI(texts);
      case 'ollama': return this.embedOllama(texts);
      case 'mock': return texts.map(t => hashVector(t));
      case 'anthropic': throw new Error('Anthropic 不支持嵌入接口');
      default: throw new Error(`不支持的 LLM 提供商: ${this.provider}`);
    }
  }

  private async chatOpenAI(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens ?? this.maxTokens,
    };
    if (options?.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const data = await this.requestJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }>(url, {
      method: 'POST',
      headers: this.authHeaders('openai'),
      body: JSON.stringify(body),
    });

    return {
      content: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  private async chatAnthropic(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    const split = splitSystemMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: split.messages,
      ...(split.system ? { system: split.system } : {}),
    };

    const data = await this.requestJson<{
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(url, {
      method: 'POST',
      headers: this.authHeaders('anthropic'),
      body: JSON.stringify(body),
    });

    return {
      content: data.content?.map(c => c.text ?? '').join('') ?? '',
      usage: data.usage ? {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : undefined,
    };
  }

  private async chatOllama(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.baseUrl ?? 'http://localhost:11434'}/api/chat`;
    const body = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: options?.temperature ?? this.temperature,
        num_predict: options?.maxTokens ?? this.maxTokens,
      },
    };

    const data = await this.requestJson<{ message?: { content?: string } }>(url, {
      method: 'POST',
      headers: this.authHeaders('ollama'),
      body: JSON.stringify(body),
    });

    return { content: data.message?.content ?? '' };
  }

  private chatMock(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const text = messages.map(m => m.content).join('\n');

    if (text.includes('TASK:ALTERNATIVES')) {
      return Promise.resolve({
        content: JSON.stringify({ alternatives: ['Option A', 'Option B', 'Option C'] }),
      });
    }
    if (text.includes('TASK:SIMULATE')) {
      return Promise.resolve({
        content: JSON.stringify({
          outcomes: ['可能获得稳定收益', '短期波动可控'],
          valueAlignment: { stability: 0.7, curiosity: 0.4 },
          constraintViolations: [],
          riskScore: 0.35,
          confidence: 0.6,
        }),
      });
    }
    if (text.includes('TASK:EXPLAIN')) {
      return Promise.resolve({
        content: JSON.stringify({
          summary: '该选项在多次模拟中表现稳定，风险处于可接受范围。',
          evidence: [],
          counterfactuals: [],
        }),
      });
    }

    return Promise.resolve({
      content: options?.responseFormat === 'json' ? '{}' : 'OK',
    });
  }

  private async embedOpenAI(texts: readonly string[]): Promise<number[][]> {
    const url = `${this.baseUrl ?? 'https://api.openai.com'}/v1/embeddings`;
    const data = await this.requestJson<{
      data?: Array<{ embedding?: number[] }>;
    }>(url, {
      method: 'POST',
      headers: this.authHeaders('openai'),
      body: JSON.stringify({ model: this.embeddingModel, input: texts }),
    });
    return (data.data ?? []).map(d => d.embedding ?? []);
  }

  private async embedOllama(texts: readonly string[]): Promise<number[][]> {
    const url = `${this.baseUrl ?? 'http://localhost:11434'}/api/embed`;
    const data = await this.requestJson<{ embeddings?: number[][] }>(url, {
      method: 'POST',
      headers: this.authHeaders('ollama'),
      body: JSON.stringify({ model: this.embeddingModel, input: texts }),
    });
    return data.embeddings ?? [];
  }

  private authHeaders(provider: LLMProviderName): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) {
      if (provider === 'anthropic') {
        headers['x-api-key'] = this.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.authorization = `Bearer ${this.apiKey}`;
      }
    }
    return headers;
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
        return text ? JSON.parse(text) as T : {} as T;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(BACKOFF_BASE_MS * (2 ** attempt));
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastErr;
  }
}
