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

import type { McpToolSchema, ToolCompileResult } from '@chrono/kernel';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgTask } from './types.js';
import type { ExecutionRiskSignals } from './execution-risk.js';
import { assessExecutionRisk } from './execution-risk.js';
import type { DeclaredRiskSignals } from './tool-risk-deriver.js';
import { resolveWorkerExecutionActor } from './worker-execution-actor.js';
import type { ApprovalService } from './approval-service.js';
import type { LearningRequestService, RegisterGapOutcome } from './learning-request-service.js';
import type { TaskDispositionService } from './task-disposition-service.js';

/** 工具执行管线的窄接口（只需 invoke；与 ToolInvocationPipeline 形状一致，便于解耦+单测）。 */
export interface ToolExecutor {
  invoke(request: ToolInvokeRequest): Promise<ToolInvokeDecision>;
}

/**
 * 工具参数编译器的窄接口（ADR-0060 T1，只需 compile；与 ToolActionCompilerService 形状一致，解耦+单测）。
 * 运行时零-LLM：据确定性规则把任务字段编译成工具 arguments。返回 ok=plan / fail-closed（要求人工补，绝不猜）。
 */
export interface ToolActionParamCompiler {
  compile(input: {
    readonly personaId: string;
    readonly toolId: string;
    readonly capability: string;
    readonly toolSchema: McpToolSchema;
    readonly schemaVersion: string;
    readonly taskFields: Readonly<Record<string, unknown>>;
  }): ToolCompileResult;
}

/**
 * 目标工具的 inputSchema 解析器（从 ToolRegistry 读）——编译需要 schemaVersion 比对 + 必填校验。
 * 返回 null = 工具未注册（→ 无法编译，回退调用方 arguments，与 no_rule 同向后兼容语义）。
 */
export type ToolSchemaResolver = (toolId: string) => { readonly schema: McpToolSchema; readonly schemaVersion: string } | null;

/**
 * 工具动态风险派生器窄接口（= deriveRiskSignals 固定 registry 后的 curry）——据**最终执行参数**从 registry
 * 派生工具动态风险 + 合并调用方声明信号（只增不减）。args 必须是编译后的 effectiveArguments，非裸参数。
 */
export type ToolRiskDeriver = (
  toolId: string,
  args: Record<string, unknown>,
  declared: DeclaredRiskSignals | undefined,
) => DeclaredRiskSignals;

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
  /**
   * ADR-0060 T1：有匹配 active 工具动作规则，但据规则从任务字段**确定性构造参数失败**（缺字段/冲突/过期/
   * schema 不符/枚举越界）→ **不硬干、不用调用方裸参数蒙混**（否则规则形同虚设）：退回任务待人工补规则/字段，
   * 绝不调 LLM 猜参（零-LLM fail-closed 铁律）。仅当有规则却构造失败才返回；no_rule（压根没规则）走向后兼容回退。
   */
  | { readonly kind: 'param_compile_failed'; readonly code: string; readonly reason: string }
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
    /**
     * ADR-0060 T1：可选工具参数编译器。注入后，执行前用**确定性规则**从任务字段编译工具 arguments，
     * 覆盖调用方传入的裸参数（让数字人真正「自己会用工具」，运行时零-LLM）。**可选**向后兼容
     * （未注入 = 旧行为，直接用调用方传入的 arguments）。与 schemaResolver 成对注入才生效。
     */
    private readonly compiler?: ToolActionParamCompiler,
    /**
     * ADR-0060 T1：目标工具 inputSchema 解析器（从 ToolRegistry 读，供编译比对 schemaVersion + 校验必填）。
     * 与 compiler 成对注入；任一缺省 = 不编译（回退调用方 arguments）。
     */
    private readonly schemaResolver?: ToolSchemaResolver,
    /**
     * 工具动态风险派生器（读 registry 的 metadata.highRisk + isHighRisk(args)，合并调用方声明信号，只增不减）。
     * **必须**用**编译后的最终执行参数**派生——否则「按裸参数评估风险、按编译参数执行」= 审批门绕过（Codex 交叉审查
     * 致命）。注入后 service 内部用 effectiveArguments 重新派生；未注入 = 旧行为（直接用 input.riskSignals，
     * 向后兼容：未接编译器的调用方本就传预派生信号）。
     */
    private readonly riskDeriver?: ToolRiskDeriver,
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

    /* persona 从 **input.workerId** 解析（非 stale task）：requireExecutableTask 已确认此刻 assignee===workerId，
     * 与后续 CAS 锁定的执行人格口径一致。编译/风险派生都用它，杜绝 stale task 串味。 */
    const personaId = this.personaIdOfWorker(input.orgId, input.workerId);

    /* ① 参数编译（ADR-0060 T1，零-LLM）——**必须在风险门之前**：编译产物是本次的**最终执行参数**，
     *    风险派生/审批门都要据它算，否则「按裸参数评估风险、按编译参数执行」= 审批门绕过（Codex 交叉审查致命）。
     *    fail-closed 语义（红线 5/fail-closed 铁律）：
     *      - no_rule（该 persona/tool/capability 尚无规则）/ 未配编译器 / 工具未注册 / 任务无声明能力 → 回退调用方
     *        arguments（向后兼容，规则表空不打挂现有执行）；
     *      - 其它 fail-closed（缺字段/冲突/过期/schema 不符/枚举越界）→ **不硬干**：param_compile_failed，绝不用裸
     *        参数蒙混（否则「有规则却构造失败」被绕过，规则形同虚设）。
     *    编译在 CAS **之前**：失败时任务仍 delegated（未抢 in_progress），直接返回**无需退回状态**。 */
    const compiled = this.compileArguments(input, personaId, task);
    if (compiled.kind === 'param_compile_failed') return compiled;
    const effectiveArguments = compiled.arguments;

    /* ② 风险派生 + 风险门（铁律1 只升不降）：**用编译后的最终执行参数** effectiveArguments 派生工具动态风险
     *    （注入 riskDeriver 时读 registry 的 isHighRisk(effectiveArguments) + 合并调用方声明信号；未注入 = 旧行为，
     *    直接用 input.riskSignals）。这样风险门看到的与实际执行的是**同一组参数**，杜绝错配绕过。 */
    const signals = this.riskDeriver
      ? this.riskDeriver(input.toolId, effectiveArguments, input.riskSignals)
      : (input.riskSignals ?? {});
    const assessment = assessExecutionRisk({ taskRisk: task.riskLevel, ...signals });

    /* ③ 审批门（D2）：非 low **必须**有已放行审批，且审批**绑定本次执行**（subject=本 task、发起者=本 worker、
     *    批准风险≥本次有效风险）——只看 status=approved 会被同 org 任意旧/跨任务/低风险批准放行（Codex 复审致命）。 */
    if (assessment.effectiveRisk !== 'low') {
      if (!input.approvalId) {
        return { kind: 'needs_approval', effectiveRisk: assessment.effectiveRisk, reason: assessment.rationale };
      }
      /* ⚠️ 审计 #407：改为**消费**而非纯读校验。
       *
       * 此前用 `isExecutionApprovalCleared`（只读），批准后 status 永远停在
       * approved，任务一旦回到 delegated（pipeline pending_confirmation 退回 /
       * L8a 唤醒 / 改派），同一 approvalId 就能再次放行 —— 实测一次人类批准
       * 放行了 **2 次**真实高风险工具调用，且第二次参数完全不同。
       *
       * `consumeExecutionApproval` 先做全部匹配校验、再原子占用（CAS
       * `WHERE status='approved' AND consumed_at IS NULL`），故：
       *   - 复用 → 第二次 changes=0 → 拒绝；
       *   - 并发 → 只有一次能抢到。 */
      const cleared = this.approvals.consumeExecutionApproval({
        orgId: input.orgId, approvalId: input.approvalId,
        subjectType: 'task_execution', subjectId: input.taskId,
        requesterWorkerId: input.workerId, effectiveRisk: assessment.effectiveRisk,
      });
      if (!cleared) {
        return { kind: 'needs_approval', effectiveRisk: assessment.effectiveRisk, reason: '审批未放行/已过期/已被使用/与本次执行不匹配（任务/发起者/风险等级/参数）' };
      }
    }

    /* ④ actor 身份（D1）：org_worker + 人类 principal 绝不为空（resolve 内部对空 principal 抛错）。 */
    const actor = resolveWorkerExecutionActor(input.workerId, input.principalUserId);

    /* ⑤ 并发门：CAS delegated→in_progress，**且锁 assignee=input.workerId**。只按 status 会有致命竞态：
     *    requireExecutableTask 校验 assignee 后、本 CAS 前，任务若被并发 reassign 改派给别人（仍 delegated），
     *    旧 worker 凭 status-only CAS 仍抢到执行 → 跨人格/越权执行（功能评审 Codex 确认 High）。CAS 约束
     *    assigned_to_worker_id 后，改派即令本次 CAS 落空、安全中止。 */
    if (!this.store.transitionTaskExecutionIfStatus(input.orgId, input.taskId, 'delegated', 'in_progress', null, this.now(), input.workerId)) {
      throw new WorkerExecutionError(`任务 ${input.taskId} 非 delegated 或已被并发执行/改派，无法发起执行`);
    }

    /* ⑥ 真实执行：调用管线。管线自身 confirmation 与审批门叠加（铁律4）。 */
    let decision: ToolInvokeDecision;
    try {
      decision = await this.executor.invoke({
        tenantId: this.tenantId,
        personaId,
        toolId: input.toolId,
        invokerType: actor.invokerType,
        invokerId: actor.invokerId,
        invokerUserId: actor.invokerUserId,
        arguments: effectiveArguments,
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

  /**
   * ADR-0060 T1：据确定性规则把任务字段编译成工具 arguments（零-LLM）。返回：
   *   - { kind:'ok', arguments }：用编译出的参数（有规则命中）或回退调用方裸参数（no_rule/未配编译器）；
   *   - { kind:'param_compile_failed', code, reason }：有规则但构造失败（缺字段/冲突/过期/schema 不符/枚举越界）。
   *
   * capability 选择：任务可能声明多个 requiredCapabilities，但一次调用只对应一个 (capability, toolId) 规则。
   * 遍历顺序尝试——首个 ok 即用；首个**非 no_rule** 的 fail-closed 即拦截（有规则却构造失败不放行）；
   * 全 no_rule → 回退（该工具在这些 capability 下都没学过规则，按向后兼容用调用方 arguments）。
   */
  private compileArguments(
    input: ExecuteTaskInput, personaId: string, task: OrgTask,
  ): { readonly kind: 'ok'; readonly arguments: Readonly<Record<string, unknown>> } | Extract<ExecuteTaskResult, { kind: 'param_compile_failed' }> {
    /* 未配编译器/解析器（向后兼容）、工具未注册、或任务无声明能力 → 不编译，用调用方 arguments。 */
    if (!this.compiler || !this.schemaResolver || task.requiredCapabilities.length === 0) {
      return { kind: 'ok', arguments: input.arguments };
    }
    const resolved = this.schemaResolver(input.toolId);
    if (!resolved) return { kind: 'ok', arguments: input.arguments }; /* 工具未注册 → 回退（与 no_rule 同向后兼容） */

    const taskFields = this.taskFields(task);
    for (const capability of task.requiredCapabilities) {
      const result = this.compiler.compile({
        personaId, toolId: input.toolId, capability,
        toolSchema: resolved.schema, schemaVersion: resolved.schemaVersion, taskFields,
      });
      if (result.ok) return { kind: 'ok', arguments: result.plan.arguments };
      /* no_rule：这个 capability 下该工具没学过规则——继续试下一个 capability，别拦。 */
      if (result.code === 'no_rule') continue;
      /* 其它 fail-closed（有规则却构造失败）：拦截，不用裸参数蒙混。 */
      return { kind: 'param_compile_failed', code: result.code, reason: result.reason };
    }
    /* 所有声明能力都 no_rule → 该工具尚无任何适用规则，向后兼容回退调用方 arguments。 */
    return { kind: 'ok', arguments: input.arguments };
  }

  /**
   * 从任务提取供编译取值的结构化字段（确定性、稳定键序）。只暴露 A0 契约里的稳定字段——
   * pick/template/enum 规则据此取值；规则引用不存在的字段 → 编译 fail-closed（missing_field），不猜。
   */
  private taskFields(task: OrgTask): Readonly<Record<string, unknown>> {
    return {
      taskId: task.id,
      title: task.title,
      taskType: task.taskType,
      acceptanceCriteria: task.acceptanceCriteria,
      riskLevel: task.riskLevel,
      goalId: task.goalId,
    };
  }

  /** 执行产出摘要（确定性，不编故事）。 */
  private summarize(toolId: string, invocationId: string): string {
    return `已执行工具 ${toolId}（invocation ${invocationId}）`;
  }
}
