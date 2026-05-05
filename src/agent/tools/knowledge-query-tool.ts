/**
 * knowledge.query — 在 persona_knowledge_items 中检索相关条目
 *
 * 复用 ConversationKnowledgeRetriever（关键词 + 可选 embedding 语义层）。
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { ConversationKnowledgeRetriever } from '../../conversation/conversation-knowledge-retriever.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

export class KnowledgeQueryTool implements ToolAdapter {
  readonly metadata = {
    id: 'knowledge.query',
    displayName: 'Query Knowledge Base',
    description: '从人格知识库中检索相关条目（关键词 + 可选语义匹配）',
    highRisk: false,
    defaultTimeoutMs: 10_000,
    defaultMaxPerDay: 1000,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        topK: { type: 'number', default: 5, minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };

  constructor(private readonly retriever: ConversationKnowledgeRetriever) {}

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const query = requireString(ctx.arguments, 'query');
    if (query.length > 500) {
      throw new ValidationError('query 长度不可超过 500 字符', ErrorCode.VALIDATION_FORMAT);
    }
    const topK = Math.max(1, Math.min(20, Math.round(numberOr(ctx.arguments, 'topK', 5))));

    const results = await this.retriever.retrieve({
      tenantId: ctx.tenantId,
      personaId: ctx.personaId,
      userInput: query,
      topK,
    });

    const json = JSON.stringify(results);
    return {
      content: [{ type: 'json', json: results }],
      costCents: 0,
      outputSizeBytes: Buffer.byteLength(json, 'utf8'),
    };
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
