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
import type { LearningRequestService, RegisterGapOutcome } from './learning-request-service.js';
import type { TaskDispositionService } from './task-disposition-service.js';

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
  /**
   * ADR-0057 L2/D0.8：执行前确定性缺口检测发现该数字员工缺所需能力 → **不执行**，登记学习请求并把任务挂起
   * （blocked，原因=能力缺口）。**不当场调 LLM 硬答**（零-LLM 铁律）；学完唤醒重跑（L8a）。
   * 注入 disposition（L8b）则在挂起**之前**先尝试委派/降级，这里只在兜底挂起时返回 learning_required。
   */
  | { readonly kind: 'learning_required'; readonly gaps: readonly RegisterGapOutcome[]; readonly reason: string }
  /** ADR-0057 L8b：缺口已委派给有能力的同事（任务换 TA 做，仍 delegated）。学习请求仍登记（缺口异步补）。 */
  | { readonly kind: 'delegated_to_colleague'; readonly toWorkerId: string; readonly gaps: readonly RegisterGapOutcome[]; readonly reason: string }
  /** ADR-0057 L8b：缺口无法委派 + 任务允许降级 → 已降级完成（submitted + [降级] 标注，不假完成）。 */
  | { readonly kind: 'degraded'; readonly note: string; readonly gaps: readonly RegisterGapOutcome[] }
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
    /**
     * ADR-0057 L2：可选学习请求 service。注入后，执行前先做确定性能力缺口检测——缺能力则登记学习请求 +
     * 挂起任务（learning_required），不硬干。**可选**以向后兼容（未注入 = 旧行为，不做缺口检测）。
     */
    private readonly learning?: LearningRequestService,
    /**
     * ADR-0057 L8b：可选缺口处置 service。注入后，缺口挂起**之前**先尝试委派（换有能力的同事做）/降级
     * （保守版+标注）；都不行才挂起（L8a）。**可选**向后兼容（未注入 = 直接挂起，L8a 行为）。
     */
    private readonly disposition?: TaskDispositionService,
  ) {}

  /**
   * 数字员工真实执行一个已委派任务。确定性门控顺序：前置校验 → 风险门 → 审批门 → actor → CAS 并发门 →
   * 真实执行 → 写回。任一门不过：不进入执行（不抢 in_progress），返回对应 kind，任务状态不被破坏。
   */
  async execute(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
    const task = this.requireExecutableTask(input.orgId, input.taskId, input.workerId);

    /* ⓪ 能力缺口门（ADR-0057 L2/D0.8）：执行前确定性检测——该数字员工缺任务所需能力则**不硬干**，
     *    登记学习请求 + 挂起任务（零-LLM 铁律：遇缺口不当场调 LLM）。在风险/审批/CAS **之前**短路，
     *    避免为一个学不会的任务白烧审批/并发状态。未注入 learning service = 跳过（向后兼容）。 */
    if (this.learning && task.requiredCapabilities.length > 0) {
      /* persona 用 **input.workerId** 解析（非 task 快照）：requireExecutableTask 已确认此刻 assignee===workerId，
       * 故二者等价；显式用 workerId 与执行门口径一致、去除 stale-task 表象。学习请求按此 worker 的**客观能力缺口**
       * 登记，与后续是否被改派无关——缺口是这名数字员工自身的事实，改派不会使其消失，故有意不随挂起 CAS 回滚。 */
      const personaId = this.personaIdOfWorker(input.orgId, input.workerId);
      const outcomes = this.learning.detectAndRegister({
        orgId: input.orgId,
        personaId,
        requiredCapabilities: task.requiredCapabilities,
        taskId: input.taskId,
        priority: task.riskLevel === 'high' ? 'high' : task.riskLevel === 'medium' ? 'medium' : 'low',
      });
      if (outcomes.length > 0) {
        const caps = outcomes.map((o) => o.capability).join(', ');

        /* L8b 缺口处置：挂起**之前**先尝试委派/降级（尽量不卡死，优先级 委派>降级>挂起）。学习请求**已登记
         * 不回滚**（缺口客观存在，无论怎么处置都让该 persona 异步学，下次同类零-LLM 干）。注入 disposition 才走。 */
        if (this.disposition) {
          const d = this.disposition.dispose({
            orgId: input.orgId, task, currentWorkerId: input.workerId,
            missingCapabilities: outcomes.map((o) => o.capability),
          });
          if (d.kind === 'delegated') {
            return { kind: 'delegated_to_colleague', toWorkerId: d.toWorkerId, gaps: outcomes, reason: `缺能力：${caps}——已委派给有能力的同事 ${d.toWorkerId}（学习请求已登记）` };
          }
          if (d.kind === 'degraded') {
            return { kind: 'degraded', note: d.note, gaps: outcomes };
          }
          /* d.kind === 'suspend'：落回 L8a 挂起。 */
        }

        /* 挂起任务（delegated→blocked，原因=能力缺口）——**CAS 且锁 assignee**：本路径未抢 in_progress、不拥有
         * 任务状态，若任务已被并发改走（状态变 / reassign 改派给别人）则不覆盖（Codex 复审）。CAS 同时约束
         * assigned_to_worker_id=input.workerId，避免任务在能力检测后被改派、本 worker 仍把别人的任务挂起。
         * 学习请求已登记不回滚（缺口客观存在）；CAS 没抢到说明状态/指派已变，按并发冲突抛错让调用方重试。 */
        if (!this.store.transitionTaskExecutionIfStatus(input.orgId, input.taskId, 'delegated', 'blocked', `能力缺口待进修：${caps}`, this.now(), input.workerId)) {
          throw new WorkerExecutionError(`任务 ${input.taskId} 非 delegated 或已被并发改动/改派，挂起失败（学习请求已登记，请重试）`);
        }
        return { kind: 'learning_required', gaps: outcomes, reason: `缺能力：${caps}（已登记学习请求，待进修后重跑）` };
      }
    }

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

    /* ④ 并发门：CAS delegated→in_progress，**且锁 assignee=input.workerId**。只按 status 会有致命竞态：
     *    requireExecutableTask 校验 assignee 后、本 CAS 前，任务若被并发 reassign 改派给别人（仍 delegated），
     *    旧 worker 凭 status-only CAS 仍抢到执行，并用**下方 stale task 对象里的旧 assignee** 解析 persona 内核执行
     *    ——跨人格/越权执行（功能评审 Codex 确认 High）。CAS 约束 assigned_to_worker_id 后，改派即令本次 CAS 落空、
     *    安全中止。 */
    if (!this.store.transitionTaskExecutionIfStatus(input.orgId, input.taskId, 'delegated', 'in_progress', null, this.now(), input.workerId)) {
      throw new WorkerExecutionError(`任务 ${input.taskId} 非 delegated 或已被并发执行/改派，无法发起执行`);
    }

    /* ⑤ 真实执行：调用管线。管线自身 confirmation 与审批门叠加（铁律4）。 */
    let decision: ToolInvokeDecision;
    try {
      decision = await this.executor.invoke({
        tenantId: this.tenantId,
        /* persona 从 **CAS 已锁定的 input.workerId** 解析（非 stale task 对象）：④ 的 assignee-scoped CAS 已确保
         * 任务此刻仍指派给本 worker，用其 worker→persona 是本次执行的唯一合法人格上下文，杜绝 stale task 串味。 */
        personaId: this.personaIdOfWorker(input.orgId, input.workerId),
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

  /** 取指定 worker 绑定的人格内核 id（喂给管线做权限/人格上下文）。执行门/缺口检测都用 workerId，非 stale task。 */
  private personaIdOfWorker(orgId: string, workerId: string): string {
    const worker = this.store.getWorker(orgId, workerId);
    return worker?.personaId ?? '';
  }

  /** 执行产出摘要（确定性，不编故事）。 */
  private summarize(toolId: string, invocationId: string): string {
    return `已执行工具 ${toolId}（invocation ${invocationId}）`;
  }
}
