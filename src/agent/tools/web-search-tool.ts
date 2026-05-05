/**
 * web_search — 网络搜索工具
 *
 * 后端：Exa（首选）/ Serper（fallback）/ mock（默认开发模式）。
 * SSRF 安全：直连 provider HTTPS，不走用户提供 URL，无 SSRF 风险。
 *
 * 结果策略：
 *  - 单条 content 截断到 maxContentLength 字符
 *  - 最多返回 maxResults 条
 *  - 拒绝过长 query (>500 字符)
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { Logger } from '../../utils/logger.js';
import { ValidationError, StateError, ErrorCode } from '../../errors/index.js';

export interface WebSearchOptions {
  readonly provider: 'exa' | 'serper' | 'mock';
  readonly apiKey?: string;
  readonly maxResults: number;
  readonly maxContentLength: number;
  readonly costCentsPerCall: number;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

const SEARCH_TIMEOUT_MS = 15_000;

export class WebSearchTool implements ToolAdapter {
  readonly metadata = {
    id: 'web_search',
    displayName: 'Web Search',
    description: '基于 Exa/Serper 的网络搜索；返回标题、URL、摘要，不下载页面正文',
    highRisk: false,
    defaultTimeoutMs: SEARCH_TIMEOUT_MS,
    defaultMaxPerDay: 200,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        topK: { type: 'number', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly options: WebSearchOptions,
    logger: Logger,
  ) {
    if (options.provider !== 'mock' && !options.apiKey) {
      logger.warn('WebSearchTool', `provider=${options.provider} 但未配置 apiKey；调用时将抛错`);
    }
  }

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const query = requireString(ctx.arguments, 'query');
    if (query.length > 500) {
      throw new ValidationError('query 长度不可超过 500 字符', ErrorCode.VALIDATION_FORMAT);
    }
    const requested = Math.max(1, Math.min(20, Math.round(numberOr(ctx.arguments, 'topK', 5))));
    const topK = Math.min(requested, this.options.maxResults);

    const results = await this.search(query, topK, ctx.deadline);
    const truncated = results.slice(0, topK).map((r) => ({
      title: r.title.slice(0, 200),
      url: r.url,
      snippet: r.snippet.slice(0, this.options.maxContentLength),
    }));

    const json = JSON.stringify({ query, results: truncated });
    return {
      content: [{ type: 'json', json: { query, results: truncated } }],
      costCents: this.options.costCentsPerCall,
      outputSizeBytes: Buffer.byteLength(json, 'utf8'),
    };
  }

  private async search(query: string, topK: number, deadline: number): Promise<WebSearchResult[]> {
    if (this.options.provider === 'mock') {
      return [
        { title: `mock result for "${query}"`, url: 'https://example.com/mock', snippet: 'Mock provider 不会真发网络请求' },
      ];
    }
    if (!this.options.apiKey) {
      throw new StateError(`web_search provider=${this.options.provider} 但未配置 apiKey`, ErrorCode.STATE_INVALID_TRANSITION);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StateError('web_search 截止时间已过', ErrorCode.STATE_INVALID_TRANSITION);
    }
    const timeoutMs = Math.min(remaining, SEARCH_TIMEOUT_MS);

    if (this.options.provider === 'exa') {
      return await this.searchExa(query, topK, this.options.apiKey, timeoutMs);
    }
    return await this.searchSerper(query, topK, this.options.apiKey, timeoutMs);
  }

  private async searchExa(query: string, topK: number, apiKey: string, timeoutMs: number): Promise<WebSearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ query, numResults: topK, type: 'auto' }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new StateError(`Exa search 失败: HTTP ${res.status}`, ErrorCode.STATE_INVALID_TRANSITION);
      }
      const json = await res.json() as { results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }> };
      return (json.results ?? []).map((r) => ({
        title: typeof r.title === 'string' ? r.title : '(untitled)',
        url: typeof r.url === 'string' ? r.url : '',
        snippet: typeof r.text === 'string' ? r.text : (typeof r.snippet === 'string' ? r.snippet : ''),
      })).filter((r) => r.url.length > 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchSerper(query: string, topK: number, apiKey: string, timeoutMs: number): Promise<WebSearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ q: query, num: topK }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new StateError(`Serper search 失败: HTTP ${res.status}`, ErrorCode.STATE_INVALID_TRANSITION);
      }
      const json = await res.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
      return (json.organic ?? []).map((r) => ({
        title: typeof r.title === 'string' ? r.title : '(untitled)',
        url: typeof r.link === 'string' ? r.link : '',
        snippet: typeof r.snippet === 'string' ? r.snippet : '',
      })).filter((r) => r.url.length > 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`参数 ${key} 必须为非空字符串`, ErrorCode.VALIDATION_REQUIRED);
  }
  return value;
}

function numberOr(args: Record<string, unknown>, key: string, def: number): number {
  const value = args[key];
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`参数 ${key} 必须为数字`, ErrorCode.VALIDATION_FORMAT);
  }
  return value;
}
