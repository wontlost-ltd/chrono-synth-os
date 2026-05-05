/**
 * memory.search — 在 persona memories 中搜索相关条目
 *
 * 复用 PersonaCoreService.searchPersonaMemories（关键词匹配 + importance 加权）。
 * 返回 score 排序的记忆 id + summary 列表。
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

export class MemorySearchTool implements ToolAdapter {
  readonly metadata = {
    id: 'memory.search',
    displayName: 'Search Memories',
    description: '在人格记忆中搜索相关条目，返回 score 排序的列表',
    highRisk: false,
    defaultTimeoutMs: 8000,
    defaultMaxPerDay: 2000,
    inputSchema: {
      type: 'object' as const,
      properties: {
        ownerUserId: { type: 'string' },
        query: { type: 'string', minLength: 1, maxLength: 500 },
        topK: { type: 'number', default: 5, minimum: 1, maximum: 50 },
      },
      required: ['ownerUserId', 'query'],
      additionalProperties: false,
    },
  };

  constructor(private readonly personaCoreService: PersonaCoreService) {}

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const ownerUserId = requireString(ctx.arguments, 'ownerUserId');
    const query = requireString(ctx.arguments, 'query');
    if (query.length > 500) {
      throw new ValidationError('query 长度不可超过 500 字符', ErrorCode.VALIDATION_FORMAT);
    }
    const topK = Math.max(1, Math.min(50, Math.round(numberOr(ctx.arguments, 'topK', 5))));

    const results = this.personaCoreService.searchPersonaMemories(
      ctx.tenantId, ownerUserId, ctx.personaId, query, topK,
    );
    if (results === null) {
      throw new ValidationError('Persona 不存在或无权访问', ErrorCode.NOT_FOUND_PERSONA);
    }

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
