/**
 * 数字员工真实执行 service（D3，ADR-0055）——把一个已委派任务确定性地接到 ToolInvocationPipeline 真实执行。
 *
 * 这是数字员工从「只会分解/委派/汇报」到「真的动手干活」的接线切片。执行链路（全确定性、零-LLM）：
 *   1. 风险门：assessExecutionRisk 算有效风险（铁律1 只升不降）；
 *   2. 审批门（D2）：非 low 必须有**已放行**的 org_approvals（按 approvalId 校验，不是任意旧批准）；
 *   3. actor 身份（D1）：resolveWorkerExecutionActor —— org_worker + **人类法律 principal 绝不为空**；
 *   4. 并发门：CAS 把任务 delegated→in_progress（只有抢到的执行者真正调用工具，防并发重复执行）；
 *   5. 真实执行：pipeline.invoke（管线自身的 confirmation 与审批门**叠加**，铁律4——
 *      管线返回 pending_confirmation 时**不自动补 token**，回 needs_pipeline_confirmation 让人类显式确认）；
 *   6. 写回：成功 submitted，失败/超时/拒绝 blocked（带原因），并把 in_progress 退回，留审计。
 *
 * 设计取舍：依赖 ToolExecutor 窄接口（只要 invoke），不绑死整个 kernel pipeline——便于单测且解耦。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgTask } from './types.js';
import type { ExecutionRiskSignals } from './execution-risk.js';
import { assessExecutionRisk } from './execution-risk.js';
import { resolveWorkerExecutionActor } from './worker-execution-actor.js';
import type { ApprovalService } from './approval-service.js';

/** 工具执行管线的窄接口（只需 invoke；与 ToolInvocationPipeline 形状一致，便于解耦+单测）。 */
export interface ToolExecutor {
  invoke(request: ToolInvokeRequest): Promise<ToolInvokeDecision>;
}

/** 喂给管线的调用请求（org_worker 执行用子集）。 */
export interface ToolInvokeRequest {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly invokerType: 'org_worker';
  readonly invokerId: string;
  readonly invokerUserId: string;
  readonly arguments: Record<string, unknown>;
  readonly confirmationToken?: string;
}

/** 管线决策（与 InvocationDecision 一致的判别联合）。 */
export type ToolInvokeDecision =
  | { readonly ok: true; readonly invocationId: string; readonly result: unknown }
  | {
      readonly ok: false;
      readonly invocationId: string;
      readonly status:
        | 'tool_not_found' | 'denied_permission' | 'denied_quota' | 'denied_budget'
        | 'denied_circuit_open' | 'denied_authorization' | 'pending_confirmation' | 'failed' | 'timeout';
      readonly reason: string;
      readonly confirmationTokenId?: string;
    };

/** 一次真实执行请求。 */
export interface ExecuteTaskInput {
  readonly orgId: string;
  /** 执行哪个任务（必须 delegated 且 allowsToolExecution）。 */
  readonly taskId: string;
  /** 执行者数字员工（必须是任务当前执行者）。 */
  readonly workerId: string;
  /** 人类法律 principal（org owner / 授权管理员；绝不为空——org_worker 不得无 principal 执行）。 */
  readonly principalUserId: string;
  /** 要调用的工具 id。 */
  readonly toolId: string;
  /** 工具参数。 */
  readonly arguments: Record<string, unknown>;
  /** 额外风险信号（工具自身风险/对外/敏感/资金/不可逆/二次确认）。 */
  readonly riskSignals?: Omit<ExecutionRiskSignals, 'taskRisk'>;
  /** 已放行的审批 id（非 low 任务必填——D2 审批门按此校验）。 */
  readonly approvalId?: string;
  /** 管线二次确认 token（仅在上一次返回 needs_pipeline_confirmation 后由人类显式提供，铁律4）。 */
  readonly confirmationToken?: string;
}

/** 执行结果（确定性判别联合，写回任务状态由 service 完成）。 */
export type ExecuteTaskResult =
  | { readonly kind: 'executed'; readonly invocationId: string; readonly result: unknown }
  | { readonly kind: 'needs_approval'; readonly effectiveRisk: 'medium' | 'high'; readonly reason: string }
  | { readonly kind: 'needs_pipeline_confirmation'; readonly confirmationTokenId: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly status: string; readonly reason: string };

/** 执行非法（任务状态/执行者/principal 等前置不满足）。 */
export class WorkerExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerExecutionError';
  }
}

export class WorkerExecutionService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly approvals: ApprovalService,
    private readonly executor: ToolExecutor,
    private readonly now: () => number,
    private readonly tenantId: string,
  ) {}

  /**
   * 数字员工真实执行一个已委派任务。确定性门控顺序：前置校验 → 风险门 → 审批门 → actor → CAS 并发门 →
   * 真实执行 → 写回。任一门不过：不进入执行（不抢 in_progress），返回对应 kind，任务状态不被破坏。
   */
  async execute(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
    const task = this.requireExecutableTask(input.orgId, input.taskId, input.workerId);

    /* ① 风险门（铁律1 只升不降）：有效风险据任务 + 工具/动作信号。 */
    const assessment = assessExecutionRisk({ taskRisk: task.riskLevel, ...(input.riskSignals ?? {}) });

    /* ② 审批门（D2）：非 low **必须**有已放行审批，且审批**绑定本次执行**（subject=本 task、发起者=本 worker、
     *    批准风险≥本次有效风险）——只看 status=approved 会被同 org 任意旧/跨任务/低风险批准放行（Codex 复审致命）。 */
    if (assessment.effectiveRisk !== 'low') {
      if (!input.approvalId) {
        return { kind: 'needs_approval', effectiveRisk: assessment.effectiveRisk, reason: assessment.rationale };
      }
      const cleared = this.approvals.isExecutionApprovalCleared({
        orgId: input.orgId, approvalId: input.approvalId,
        subjectType: 'task_execution', subjectId: input.taskId,
        requesterWorkerId: input.workerId, effectiveRisk: assessment.effectiveRisk,
      });
      if (!cleared) {
        return { kind: 'needs_approval', effectiveRisk: assessment.effectiveRisk, reason: '审批未放行/已过期/与本次执行不匹配（任务/发起者/风险等级）' };
      }
    }

    /* ③ actor 身份（D1）：org_worker + 人类 principal 绝不为空（resolve 内部对空 principal 抛错）。 */
    const actor = resolveWorkerExecutionActor(input.workerId, input.principalUserId);

    /* ④ 并发门：CAS delegated→in_progress；没抢到（已被并发拉起/状态变了）→ 不执行。 */
    if (!this.store.transitionTaskExecutionIfStatus(input.orgId, input.taskId, 'delegated', 'in_progress', null, this.now())) {
      throw new WorkerExecutionError(`任务 ${input.taskId} 非 delegated 或已被并发执行，无法发起执行`);
    }

    /* ⑤ 真实执行：调用管线。管线自身 confirmation 与审批门叠加（铁律4）。 */
    let decision: ToolInvokeDecision;
    try {
      decision = await this.executor.invoke({
        tenantId: this.tenantId,
        personaId: task.assignedToWorkerId ? this.personaIdOf(input.orgId, task) : '',
        toolId: input.toolId,
        invokerType: actor.invokerType,
        invokerId: actor.invokerId,
        invokerUserId: actor.invokerUserId,
        arguments: input.arguments,
        ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {}),
      });
    } catch (err) {
      /* 执行抛错（管线异常）：退回 in_progress，标 blocked 留审计，不吞异常语义。 */
      const reason = err instanceof Error ? err.message : String(err);
      this.store.updateTaskExecution(input.orgId, input.taskId, 'blocked', `执行异常：${reason}`, this.now());
      return { kind: 'failed', status: 'failed', reason };
    }

    /* ⑥ 写回：成功 submitted；pending_confirmation → blocked 但回 needs_pipeline_confirmation（人类显式确认后再执行）；
     *    其余失败/超时/拒绝 → blocked 带原因。 */
    if (decision.ok) {
      this.store.updateTaskExecution(input.orgId, input.taskId, 'submitted', this.summarize(input.toolId, decision.invocationId), this.now());
      return { kind: 'executed', invocationId: decision.invocationId, result: decision.result };
    }
    if (decision.status === 'pending_confirmation') {
      const token = decision.confirmationTokenId ?? '';
      /* pending_confirmation 非终态失败：退回 delegated（不是 blocked），让人类显式确认后带 token 重入执行门。
       * 铁律4：审批门放行 ≠ 管线确认；二者叠加，确认 token 必须由人类显式提供，service 绝不自动补。 */
      this.store.updateTaskExecution(input.orgId, input.taskId, 'delegated', `待管线二次确认（需人类显式提供 confirmation token 后重试）`, this.now());
      return { kind: 'needs_pipeline_confirmation', confirmationTokenId: token, reason: decision.reason };
    }
    this.store.updateTaskExecution(input.orgId, input.taskId, 'blocked', `执行被拦截/失败：${decision.status}（${decision.reason}）`, this.now());
    return { kind: 'failed', status: decision.status, reason: decision.reason };
  }

  /** 前置校验：任务存在 + 属于该执行者 + delegated + 允许工具执行。任一不满足 → 抛错（不进入执行）。 */
  private requireExecutableTask(orgId: string, taskId: string, workerId: string): OrgTask {
    const task = this.store.getTask(orgId, taskId);
    if (!task) throw new WorkerExecutionError(`任务 ${taskId} 不存在`);
    if (task.assignedToWorkerId !== workerId) throw new WorkerExecutionError('执行者必须是任务当前指派的数字员工');
    if (task.status !== 'delegated') throw new WorkerExecutionError(`任务须是 delegated 才能发起执行（当前 ${task.status}）`);
    if (!task.allowsToolExecution) throw new WorkerExecutionError('该任务 A0 契约未允许工具执行（allowsToolExecution=false）');
    const worker = this.store.getWorker(orgId, workerId);
    if (!worker || worker.employmentStatus !== 'active') throw new WorkerExecutionError('执行者须是组织内 active 数字员工');
    return task;
  }

  /** 取执行者数字员工绑定的人格内核 id（喂给管线做权限/人格上下文）。 */
  private personaIdOf(orgId: string, task: OrgTask): string {
    const worker = this.store.getWorker(orgId, task.assignedToWorkerId ?? '');
    return worker?.personaId ?? '';
  }

  /** 执行产出摘要（确定性，不编故事）。 */
  private summarize(toolId: string, invocationId: string): string {
    return `已执行工具 ${toolId}（invocation ${invocationId}）`;
  }
}
