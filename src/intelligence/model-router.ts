/**
 * LLM Provider 路由器
 * 统一路由到 OpenAI / Anthropic / Ollama / Mock 后端
 * 内置重试、超时和提供商特定协议适配
 */

import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider, LLMProviderName } from './llm-provider.js';
import type { TokenBudget } from './token-budget.js';
import type { CostTracker } from './cost-tracker.js';

export interface ModelRouterConfig {
  readonly provider: LLMProviderName;
  readonly model: string;
  readonly embeddingModel: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly tokenBudget?: TokenBudget;
  readonly costTracker?: CostTracker;
  readonly tenantId?: string;
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
  private readonly tenantId: string;

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
    this.tenantId = config.tenantId ?? 'default';
  }

  async chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const estimatedTokens = options?.maxTokens ?? this.maxTokens;

    /* 预检查 token 预算 */
    if (this.tokenBudget) {
      const check = this.tokenBudget.checkBudget(this.tenantId, estimatedTokens);
      if (!check.allowed) {
        throw new Error(`Token 预算不足: ${check.reason}`);
      }
    }

    let response: ChatResponse;
    switch (this.provider) {
      case 'openai': response = await this.chatOpenAI(messages, options); break;
      case 'anthropic': response = await this.chatAnthropic(messages, options); break;
      case 'ollama': response = await this.chatOllama(messages, options); break;
      case 'mock': response = await this.chatMock(messages, options); break;
      default: throw new Error(`不支持的 LLM 提供商: ${this.provider}`);
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

    /* 记录 token 使用量到预算缓存 */
    if (this.tokenBudget) {
      const totalTokens = response.usage?.totalTokens ?? 0;
      if (totalTokens > 0) {
        this.tokenBudget.recordUsage(this.tenantId, totalTokens);
      }
    }

    return response;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
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
