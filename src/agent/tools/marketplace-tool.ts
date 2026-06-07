/**
 * marketplace.act — 数字人在人才市场的经济行为工具（ADR-0048 D1）。
 *
 * 所有接活/申请/提交动作走 tool-invocation-pipeline，继承双层授权 + budget/quota/
 * confirmation/circuit-breaker。这样"自主挣钱"不绕过治理。
 *
 * actions：
 *   - list_open：列出开放任务（只读，低风险）
 *   - get_task：查任务详情（只读，低风险）
 *   - apply：申请任务（经济行为；准入由上游 EarningPolicyEngine 决策，
 *            本工具只执行 pipeline 放行的调用）
 *   - submit：提交任务结果（经济行为，交付物落库）
 *
 * 注意：assign/accept（雇主侧）与 wallet 提现不在本工具——提现按 ADR-0048 D2
 * 必须人类确认，不可由 persona 自主触发。
 */

import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

type MarketplaceAction = 'list_open' | 'get_task' | 'apply' | 'submit';
const ACTIONS: readonly MarketplaceAction[] = ['list_open', 'get_task', 'apply', 'submit'];

export class MarketplaceTool implements ToolAdapter {
  readonly metadata = {
    id: 'marketplace.act',
    displayName: 'Marketplace Action',
    description: '数字人在人才市场的经济行为：list_open / get_task / apply / submit（提现等 debit 不在此工具）',
    /* 不在工具元数据层静态标 highRisk——否则所有 action（含低风险 apply）都被强制
     * 二次确认，自主接单永远卡在 pending_confirmation（ADR-0048 治理设计）。
     * 风险分级交给上游 EarningPolicyEngine（高 reward/首 category/新 publisher →
     * needs_human_review，根本不会走到自主 apply）+ owner 的 ToolPermission
     * requireConfirmation（owner 可对 submit 等对外动作要求确认）。 */
    highRisk: false,
    defaultTimeoutMs: 15_000,
    defaultMaxPerDay: 200,
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: '经济行为类型' },
        ownerUserId: { type: 'string', description: 'persona owner 的 user_id（授权主体）' },
        taskId: { type: 'string', description: 'get_task / apply / submit 时必填' },
        assignmentId: { type: 'string', description: 'submit 时必填' },
        resultUri: { type: 'string', description: 'submit 时的交付物 URI（缺省自动生成）' },
        status: { type: 'string', description: 'list_open 时可选状态过滤（默认 open）' },
      },
      required: ['action', 'ownerUserId'],
      additionalProperties: false,
    },
  };

  constructor(private readonly personaCore: PersonaCoreService) {}

  /** ADR-0048 action 级风险：submit 是对外交付承诺 → 高风险需确认；
   * apply/list_open/get_task 低风险（apply 准入由 EarningPolicyEngine 上游门控）。 */
  isHighRisk(args: Record<string, unknown>): boolean {
    return args.action === 'submit';
  }

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const action = stringArg(ctx.arguments, 'action') as MarketplaceAction;
    if (!ACTIONS.includes(action)) {
      throw new ValidationError(`未知 marketplace action: ${action}`, ErrorCode.VALIDATION_TYPE);
    }
    const ownerUserId = stringArg(ctx.arguments, 'ownerUserId');

    switch (action) {
      case 'list_open':
        return this.listOpen(ctx);
      case 'get_task':
        return this.getTask(ctx);
      case 'apply':
        return this.apply(ctx, ownerUserId);
      case 'submit':
        return this.submit(ctx, ownerUserId);
    }
  }

  private listOpen(ctx: ToolInvocationContext): ToolInvocationResult {
    const status = optStringArg(ctx.arguments, 'status') ?? 'open';
    const tasks = this.personaCore.listMarketplaceTasks(ctx.tenantId, status as never);
    const slim = tasks.map((t) => ({
      id: t.id, title: t.title, category: t.category, reward: t.reward,
      currency: t.currency, status: t.status, publisherUserId: t.publisherUserId,
    }));
    return jsonResult({ tasks: slim, count: slim.length });
  }

  private getTask(ctx: ToolInvocationContext): ToolInvocationResult {
    const taskId = requireArg(ctx.arguments, 'taskId', 'get_task');
    const task = this.personaCore.getMarketplaceTaskById(ctx.tenantId, taskId);
    if (!task) throw new ValidationError(`任务 ${taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    return jsonResult({ task });
  }

  private apply(ctx: ToolInvocationContext, ownerUserId: string): ToolInvocationResult {
    const taskId = requireArg(ctx.arguments, 'taskId', 'apply');
    const application = this.personaCore.applyToTask({
      tenantId: ctx.tenantId,
      ownerUserId,
      personaId: ctx.personaId,
      taskId,
      actor: 'autonomous', /* 经 pipeline 的自主经济行为（ADR-0048 溯源） */
    });
    if (!application) {
      throw new ValidationError('申请失败：任务不可申请或已申请/persona 非 active', ErrorCode.STATE_INVALID_TRANSITION);
    }
    return jsonResult({ application });
  }

  private submit(ctx: ToolInvocationContext, ownerUserId: string): ToolInvocationResult {
    const taskId = requireArg(ctx.arguments, 'taskId', 'submit');
    const assignmentId = requireArg(ctx.arguments, 'assignmentId', 'submit');
    const resultUri = optStringArg(ctx.arguments, 'resultUri') ?? `marketplace://${assignmentId}/result.json`;
    const result = this.personaCore.submitTaskResult({
      tenantId: ctx.tenantId,
      ownerUserId,
      taskId,
      assignmentId,
      resultUri,
      actor: 'autonomous', /* 经 pipeline 的自主经济行为（ADR-0048 溯源） */
    });
    if (!result) {
      throw new ValidationError('提交失败：assignment 状态不允许或归属不符', ErrorCode.STATE_INVALID_TRANSITION);
    }
    return jsonResult({ result });
  }
}

/* ── arg helpers ── */
function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`参数 ${key} 必填且为非空字符串`, ErrorCode.VALIDATION_REQUIRED);
  }
  return v;
}
function optStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function requireArg(args: Record<string, unknown>, key: string, action: string): string {
  const v = optStringArg(args, key);
  if (!v) throw new ValidationError(`action=${action} 需要参数 ${key}`, ErrorCode.VALIDATION_REQUIRED);
  return v;
}
function jsonResult(payload: unknown): ToolInvocationResult {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], costCents: 0, outputSizeBytes: text.length };
}
