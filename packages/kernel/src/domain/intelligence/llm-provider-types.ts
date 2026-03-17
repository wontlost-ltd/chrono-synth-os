/**
 * LLM Provider 接口定义 — 纯领域类型
 * 提供商无关的统一接口，零 node:* 依赖
 */

export type LLMProviderName = 'openai' | 'anthropic' | 'ollama' | 'mock';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: 'json' | 'text';
}

export interface ChatResponse {
  readonly content: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface LLMProvider {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  embed(texts: readonly string[]): Promise<number[][]>;
}
