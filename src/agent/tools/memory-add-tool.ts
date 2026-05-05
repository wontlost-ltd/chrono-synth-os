/**
 * memory.add — 写入新记忆到 persona
 *
 * sourceKind 自动设为 'mcp_external'（区分用户输入与外部 MCP 写入）。
 * confidence 默认 0.6（低于用户直接输入的 0.95），符合 T0-B 安全治理基线。
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

export class MemoryAddTool implements ToolAdapter {
  readonly metadata = {
    id: 'memory.add',
    displayName: 'Add Memory',
    description: '为人格写入新记忆条目（来自外部 LLM 推断的内容）',
    highRisk: false,
    defaultTimeoutMs: 5000,
    defaultMaxPerDay: 500,
    inputSchema: {
      type: 'object' as const,
      properties: {
        ownerUserId: { type: 'string' },
        kind: { type: 'string', enum: ['interaction', 'task', 'training', 'knowledge', 'governance'] },
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        content: { type: 'object', description: '结构化内容（可空对象）' },
        importance: { type: 'number', minimum: 0, maximum: 1, default: 0.4 },
        sensitivity: { type: 'string', enum: ['private', 'encrypted', 'owner-restricted'], default: 'private' },
      },
      required: ['ownerUserId', 'kind', 'summary'],
      additionalProperties: false,
    },
  };

  constructor(private readonly personaCoreService: PersonaCoreService) {}

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const ownerUserId = requireString(ctx.arguments, 'ownerUserId');
    const kindRaw = requireString(ctx.arguments, 'kind');
    const validKinds = ['interaction', 'task', 'training', 'knowledge', 'governance'] as const;
    if (!validKinds.includes(kindRaw as typeof validKinds[number])) {
      throw new ValidationError(`非法 kind: ${kindRaw}`, ErrorCode.VALIDATION_FORMAT);
    }
    const kind = kindRaw as typeof validKinds[number];
    const summary = requireString(ctx.arguments, 'summary');
    if (summary.length > 2000) {
      throw new ValidationError('summary 长度不可超过 2000 字符', ErrorCode.VALIDATION_FORMAT);
    }
    const importance = clampNumber(numberOr(ctx.arguments, 'importance', 0.4), 0, 1);
    const sensitivityRaw = (ctx.arguments['sensitivity'] as string | undefined) ?? 'private';
    if (!['private', 'encrypted', 'owner-restricted'].includes(sensitivityRaw)) {
      throw new ValidationError(`非法 sensitivity: ${sensitivityRaw}`, ErrorCode.VALIDATION_FORMAT);
    }
    const content = (ctx.arguments['content'] as Record<string, unknown> | undefined) ?? {};

    const memory = this.personaCoreService.addMemory({
      tenantId: ctx.tenantId,
      ownerUserId,
      personaId: ctx.personaId,
      kind,
      sensitivity: sensitivityRaw as 'private' | 'encrypted' | 'owner-restricted',
      summary,
      content: { ...content, sourceKind: 'mcp_external', mcpInvokerId: ctx.invokerId },
      importance,
    });

    if (!memory) {
      throw new ValidationError('Persona 不存在或已终止', ErrorCode.NOT_FOUND_PERSONA);
    }

    const json = JSON.stringify({ memoryId: memory.id, createdAt: memory.createdAt });
    return {
      content: [{ type: 'json', json: { memoryId: memory.id, createdAt: memory.createdAt } }],
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
