/**
 * persona.get_context — 返回人格当前上下文（values / narrative / 摘要）
 *
 * 这是只读工具，但仍然走 pipeline（保证审计）。
 * 不需要 ownerUserId 校验：MCP token 已绑定 personaId，调用者已被 agency authorization 验证。
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

export class PersonaContextTool implements ToolAdapter {
  readonly metadata = {
    id: 'persona.get_context',
    displayName: 'Get Persona Context',
    description: '返回当前人格的核心上下文：values 列表、narrative、最近活跃记忆摘要',
    highRisk: false,
    defaultTimeoutMs: 5000,
    defaultMaxPerDay: 1000,
    inputSchema: {
      type: 'object' as const,
      properties: {
        ownerUserId: { type: 'string', description: '人格 owner 的 user_id' },
        includeRecentMemories: { type: 'boolean', default: true },
        recentMemoryLimit: { type: 'number', default: 10, minimum: 1, maximum: 50 },
      },
      required: ['ownerUserId'],
      additionalProperties: false,
    },
  };

  constructor(private readonly personaCoreService: PersonaCoreService) {}

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const ownerUserId = stringArg(ctx.arguments, 'ownerUserId');
    const includeRecent = boolArg(ctx.arguments, 'includeRecentMemories', true);
    const recentLimit = clampInt(numberArg(ctx.arguments, 'recentMemoryLimit', 10), 1, 50);

    const persona = this.personaCoreService.getPersonaDetail(ctx.tenantId, ownerUserId, ctx.personaId);
    if (!persona) {
      throw new ValidationError('Persona 不存在或无权访问', ErrorCode.NOT_FOUND_PERSONA);
    }

    const recentMemories = includeRecent
      ? (this.personaCoreService.listPersonaMemories(ctx.tenantId, ownerUserId, ctx.personaId, { limit: recentLimit }) ?? [])
      : [];

    const payload = {
      personaId: persona.id,
      displayName: persona.displayName,
      status: persona.status,
      profile: persona.profile,
      recentMemories: recentMemories.map((m) => ({
        id: m.id,
        kind: m.kind,
        summary: m.summary,
        importance: m.importance,
        createdAt: m.createdAt,
      })),
    };

    const json = JSON.stringify(payload);
    return {
      content: [{ type: 'json', json: payload }],
      costCents: 0,
      outputSizeBytes: Buffer.byteLength(json, 'utf8'),
    };
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`参数 ${key} 必须为非空字符串`, ErrorCode.VALIDATION_REQUIRED);
  }
  return value;
}

function numberArg(args: Record<string, unknown>, key: string, def: number): number {
  const value = args[key];
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`参数 ${key} 必须为有限数`, ErrorCode.VALIDATION_FORMAT);
  }
  return value;
}

function boolArg(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const value = args[key];
  if (value === undefined) return def;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`参数 ${key} 必须为布尔值`, ErrorCode.VALIDATION_FORMAT);
  }
  return value;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
