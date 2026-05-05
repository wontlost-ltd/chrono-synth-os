/**
 * decision.record — 记录决策到 persona 决策历史
 *
 * 实现：写入 persona_memories（kind='governance'），content 含 decisionId/choice/rationale。
 * audit_log 同时记录（由 pipeline 自动写）。
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

export class DecisionRecordTool implements ToolAdapter {
  readonly metadata = {
    id: 'decision.record',
    displayName: 'Record Decision',
    description: '记录人格做出的决策，包含 decisionId / choice / rationale',
    highRisk: false,
    defaultTimeoutMs: 5000,
    defaultMaxPerDay: 1000,
    inputSchema: {
      type: 'object' as const,
      properties: {
        ownerUserId: { type: 'string' },
        decisionId: { type: 'string', minLength: 1, maxLength: 100 },
        choice: { type: 'string', minLength: 1, maxLength: 500 },
        rationale: { type: 'string', maxLength: 5000 },
        importance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      },
      required: ['ownerUserId', 'decisionId', 'choice'],
      additionalProperties: false,
    },
  };

  constructor(private readonly personaCoreService: PersonaCoreService) {}

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const ownerUserId = requireString(ctx.arguments, 'ownerUserId');
    const decisionId = requireString(ctx.arguments, 'decisionId');
    const choice = requireString(ctx.arguments, 'choice');
    const rationale = (ctx.arguments['rationale'] as string | undefined) ?? '';
    if (rationale.length > 5000) {
      throw new ValidationError('rationale 长度不可超过 5000 字符', ErrorCode.VALIDATION_FORMAT);
    }
    const importance = clampNumber(numberOr(ctx.arguments, 'importance', 0.5), 0, 1);

    const memory = this.personaCoreService.addMemory({
      tenantId: ctx.tenantId,
      ownerUserId,
      personaId: ctx.personaId,
      kind: 'governance',
      sensitivity: 'private',
      summary: `Decision ${decisionId}: ${choice}`,
      content: {
        decisionId,
        choice,
        rationale,
        recordedVia: 'mcp.decision.record',
        invokerId: ctx.invokerId,
      },
      importance,
    });

    if (!memory) {
      throw new ValidationError('Persona 不存在或已终止', ErrorCode.NOT_FOUND_PERSONA);
    }

    const json = JSON.stringify({ memoryId: memory.id, decisionId });
    return {
      content: [{ type: 'json', json: { memoryId: memory.id, decisionId } }],
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
