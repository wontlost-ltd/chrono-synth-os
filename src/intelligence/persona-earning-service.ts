/**
 * 自主挣钱编排服务（ADR-0048 D1/D3/D4）。
 *
 * 数字人自主劳动的"神经系统"：发现 → 匹配 → 确定性决策 → 经济准入门控 →
 * 申请（走工具管线）→（被指派后）运行执行 → 提交。人类当治理者：
 * needs_human_review/forbidden 不自动申请；提现等 debit 永不在此路径（ADR-0048 D2）。
 *
 * 决策走 ADR-0047 DecisionEngine autonomous 模式（确定性，离线可跑）。
 * 经济准入走 kernel evaluateEarningAdmission（纯函数）。
 * 申请/提交走 ToolInvocationPipeline（继承双层授权 + budget/quota/confirmation）。
 */

import type { Logger } from '../utils/logger.js';
import type { Clock } from '../utils/clock.js';
import type { EventBus } from '../events/event-bus.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { ToolInvocationPipeline } from '../agent/tool-invocation-pipeline.js';
import type { PersonaLeaseStore } from '../storage/persona-lease-store.js';
import type { DecisionEngine } from './decision-engine.js';
import {
  evaluateEarningAdmission,
  evaluateAmlAggregate,
  DEFAULT_EARNING_POLICY,
  DEFAULT_AML_AGGREGATE_POLICY,
  type EarningPolicyConfig,
  type EarningPersonaSnapshot,
  type EarningAdmission,
  type MarketplaceTask,
} from '@chrono/kernel';

const LAYER = 'PersonaEarningService';
const MARKETPLACE_TOOL_ID = 'marketplace.act';
/* earning lease 存活时长：远大于单周期耗时（秒级），仅在持有者崩溃后供抢占。
 * ADR-0048：多实例下用它把「读 24h exposure → 申请」串行化，防双双超 daily cap。 */
const EARNING_LEASE_TTL_MS = 120_000;

/** 一个 persona 的挣钱周期所需上下文 */
export interface EarningCycleInput {
  readonly tenantId: string;
  readonly personaId: string;
  readonly ownerUserId: string;
  /** 该 persona 的策略（owner 在授权中心设定）；缺省用 DEFAULT */
  readonly policy?: EarningPolicyConfig;
  /** 本周期最多评估/申请几个任务 */
  readonly maxTasksPerCycle?: number;
}

export type EarningCycleDecision = 'applied' | 'skipped' | 'needs_human_review' | 'forbidden';

export interface EarningCycleTaskOutcome {
  readonly taskId: string;
  readonly title: string;
  readonly decision: EarningCycleDecision;
  readonly reasons: readonly string[];
}

export interface EarningCycleResult {
  readonly scanned: number;
  readonly applied: number;
  readonly reviewQueued: number;
  readonly skipped: number;
  readonly outcomes: readonly EarningCycleTaskOutcome[];
}

export interface PersonaEarningDeps {
  personaCore: PersonaCoreService;
  decisionEngine: DecisionEngine;
  pipeline: ToolInvocationPipeline;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  /**
   * per-persona earning lease（ADR-0048 多实例 gating item）。可选：未注入时为
   * 单进程同步语义（向后兼容）；注入后多实例会把每个 persona 的挣钱周期串行化，
   * 避免两个并发周期各自读到 stale 的 24h exposure 而双双超 daily cap。
   */
  leaseStore?: PersonaLeaseStore;
}

export class PersonaEarningService {
  constructor(private readonly deps: PersonaEarningDeps) {}

  /**
   * 运行一个挣钱周期：扫描开放任务 → 对每个任务做匹配+确定性决策+准入门控 →
   * autonomous 准入且决策 accept 才经工具管线申请。返回每个任务的处置。
   */
  async runEarningCycle(input: EarningCycleInput): Promise<EarningCycleResult> {
    const persona = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') {
      this.deps.logger.info(LAYER, `挣钱周期跳过：persona 不存在或非 active (${input.personaId})`);
      return emptyResult();
    }

    /* 多实例 gating（ADR-0048）：获取该 persona 的 earning 锁，把「读 exposure → 申请」
     * 整段串行化。拿不到锁说明另一实例正在为该 persona 跑周期，本次跳过（非错误）。
     * 未注入 leaseStore = 单进程同步语义，直接执行（向后兼容）。 */
    if (!this.deps.leaseStore) {
      return this.runCycleBody(input, persona);
    }
    const result = await this.deps.leaseStore.withLease(
      input.personaId, 'earning', this.deps.clock.now(), EARNING_LEASE_TTL_MS,
      () => this.runCycleBody(input, persona),
    );
    if (result === undefined) {
      this.deps.logger.info(LAYER, `挣钱周期跳过：earning 锁被占用，另一实例正在处理 (${input.personaId})`);
      return emptyResult();
    }
    return result;
  }

  /** 周期主体：持有 earning 锁（如启用）期间执行，读 exposure → 决策 → 申请。 */
  private async runCycleBody(
    input: EarningCycleInput,
    persona: { status: string; reputation: number },
  ): Promise<EarningCycleResult> {
    const policy = input.policy ?? DEFAULT_EARNING_POLICY;
    const maxTasks = Math.max(1, input.maxTasksPerCycle ?? 3);

    const openTasks = this.deps.personaCore.listMarketplaceTasks(input.tenantId, 'open');
    const snapshot = this.buildPersonaSnapshot(input, persona);
    /* 今日已接单累计报酬（已接但未结算的任务报酬之和），用于每日暴露上限 */
    let todayExposure = this.computeTodayExposure(input);
    /* 24h 窗口内本 persona 的接单行为任务（accepted+completed，acceptedAt 在窗口内），供 AML 聚合
     * guard 算速率/集中度/重复。本 cycle 内每接一单会增量并入（见下方 apply 成功分支）。 */
    const windowAmlTasks = this.computeAmlWindowTasks(input);
    const amlPolicy = policy.aml ?? DEFAULT_AML_AGGREGATE_POLICY;

    const outcomes: EarningCycleTaskOutcome[] = [];
    let applied = 0, reviewQueued = 0, skipped = 0;

    for (const task of openTasks.slice(0, maxTasks)) {
      /* 自己不能接自己发布的任务（AML/自接自发 guard 第一道） */
      if (task.publisherUserId === input.ownerUserId) {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'skipped', reasons: ['cannot accept self-published task'] });
        skipped++;
        continue;
      }

      /* AML/滥用 guard 第二道：publisher 异常（高取消率/刷单嫌疑）→ 拒接 */
      const amlReason = this.amlBlockReason(input, task);
      if (amlReason) {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'forbidden', reasons: [`AML: ${amlReason}`] });
        skipped++;
        continue;
      }

      /* AML/滥用 guard 第三道（ADR-0048 related-account cycling 余项）：跨 24h 窗口的**聚合模式**
       * ——单 publisher 接单速率 / 报酬集中度 / 同额机械重复。kernel 纯函数确定性判定。 */
      const amlAgg = evaluateAmlAggregate({
        candidatePublisherUserId: task.publisherUserId,
        candidateReward: task.reward,
        windowAcceptedTasks: windowAmlTasks,
        policy: amlPolicy,
      });
      if (amlAgg.blocked) {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'forbidden', reasons: amlAgg.reasons.map((r) => `AML: ${r}`) });
        skipped++;
        continue;
      }

      /* 1. 经济准入门控（kernel 纯函数） */
      const admission = evaluateEarningAdmission({
        task,
        persona: { ...snapshot, categoryCompletedCount: this.categoryCompleted(input, task.category) },
        config: policy,
        todayRewardExposure: todayExposure,
        publisherIsNew: this.publisherIsNew(input, task.publisherUserId),
      });

      if (admission.admission === 'forbidden') {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'forbidden', reasons: admission.reasons });
        skipped++;
        continue;
      }

      /* 2. 确定性接单决策（ADR-0047 autonomous 模式） */
      const decision = await this.decideAccept(task, admission.admission);

      if (admission.admission === 'needs_human_review' || decision === 'needs_human_review') {
        this.deps.bus.emit('system:earning-review-requested', {
          tenantId: input.tenantId, personaId: input.personaId, taskId: task.id,
          reward: task.reward, risk: admission.risk, reasons: admission.reasons,
        });
        outcomes.push({ taskId: task.id, title: task.title, decision: 'needs_human_review', reasons: admission.reasons });
        reviewQueued++;
        continue;
      }

      if (decision === 'skip') {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'skipped', reasons: ['decision engine: skip'] });
        skipped++;
        continue;
      }

      /* 3. autonomous + accept → 经工具管线申请 */
      const ok = await this.applyViaPipeline(input, task);
      if (ok) {
        applied++;
        todayExposure += task.reward;
        /* 把刚接的这单并入本地 AML 窗口——否则同一 cycle 内连续接同 publisher 多单时，AML 聚合 guard
         * 看不到前面刚接的，速率/集中度信号被绕过（Codex 复审 High）。与 todayExposure 增量更新同理。
         * 形态对齐 computeAmlWindowTasks 的产物（accepted + 本 persona + acceptedAt 在窗口内）。 */
        windowAmlTasks.push({
          ...task,
          status: 'accepted',
          assigneePersonaId: input.personaId,
          acceptedAt: this.deps.clock.now(),
        });
        outcomes.push({ taskId: task.id, title: task.title, decision: 'applied', reasons: ['autonomous apply via pipeline'] });
        this.deps.bus.emit('system:earning-task-applied', {
          tenantId: input.tenantId, personaId: input.personaId, taskId: task.id, reward: task.reward,
        });
      } else {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'skipped', reasons: ['pipeline denied/failed apply (governance brake)'] });
        skipped++;
      }
    }

    this.deps.logger.info(LAYER, `挣钱周期完成 ${input.personaId}: scanned=${outcomes.length} applied=${applied} review=${reviewQueued} skip=${skipped}`);
    return { scanned: openTasks.length, applied, reviewQueued, skipped, outcomes };
  }

  /** 确定性决策：accept / skip / needs_human_review（走 DecisionEngine autonomous 模式） */
  private async decideAccept(task: MarketplaceTask, admission: EarningAdmission): Promise<'accept' | 'skip' | 'needs_human_review'> {
    const result = await this.deps.decisionEngine.evaluate(
      {
        id: `earn_${task.id}`,
        title: `接受任务: ${task.title}`,
        description: `category=${task.category} reward=${task.reward} ${task.description}`,
        alternatives: ['接受任务', '跳过任务', '请人工复核'],
        context: { reward: task.reward, category: task.category, admission },
      },
      { mode: 'autonomous' },
    );
    const top = result.recommendedAlternative;
    if (top === '请人工复核') return 'needs_human_review';
    if (top === '接受任务') return 'accept';
    return 'skip';
  }

  /** 经工具管线申请任务（继承双层授权 + budget/quota/confirmation 治理） */
  private async applyViaPipeline(input: EarningCycleInput, task: MarketplaceTask): Promise<boolean> {
    const res = await this.deps.pipeline.invoke({
      tenantId: input.tenantId,
      personaId: input.personaId,
      toolId: MARKETPLACE_TOOL_ID,
      invokerType: 'internal',
      invokerId: 'persona-earning-cycle',
      invokerUserId: null,
      arguments: { action: 'apply', ownerUserId: input.ownerUserId, taskId: task.id },
    });
    if (!res.ok) {
      this.deps.logger.info(LAYER, `申请被管线拦截/失败 task=${task.id}: ${res.status}`);
    }
    return res.ok;
  }

  /* ── persona 快照与历史信号（用于 matcher + policy） ── */

  private buildPersonaSnapshot(input: EarningCycleInput, persona: { status: string; reputation: number }): EarningPersonaSnapshot {
    return {
      status: persona.status,
      reputation: persona.reputation,
      openTaskCount: this.openTaskCount(input),
      categoryCompletedCount: 0, /* 按 category 计，调用处覆盖 */
      recentFailureStreak: this.recentFailureStreak(input),
    };
  }

  /** 当前未完成（已接未结算）任务数：统计该 persona 为 assignee 且状态非 open/completed/cancelled */
  private openTaskCount(input: EarningCycleInput): number {
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = detail?.marketplaceTasks ?? [];
    return tasks.filter((t) => t.assigneePersonaId === input.personaId && t.status === 'accepted').length;
  }

  /** 今日（24h 滚动窗口）已接单累计报酬：仅计本 persona 在窗口内 acceptedAt 的任务。
   * 注意：并发触发 earning cycle 的精确防超 cap 需 DB 级 per-persona lease（多实例
   * 部署前必须加，见 ADR-0048）；当前单进程同步执行下按窗口统计已足够。 */
  private computeTodayExposure(input: EarningCycleInput): number {
    /* exposure 口径：仅「已接未结算」(accepted) 的报酬之和——这是「当前在途暴露」，completed 已结算不计。 */
    const windowStart = this.deps.clock.now() - 86_400_000;
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = detail?.marketplaceTasks ?? [];
    return tasks
      .filter((t) => t.assigneePersonaId === input.personaId && t.status === 'accepted' && (t.acceptedAt ?? 0) >= windowStart)
      .reduce((sum, t) => sum + t.reward, 0);
  }

  /** 24h 滚动窗口内本 persona 的**接单行为**任务（AML 聚合 guard 用）。
   * 口径含 accepted **与 completed**（acceptedAt 在窗口内）——wash-trading 常「快速接单并完成」，
   * 若只看 accepted，完成后的刷单任务会从窗口消失导致漏判（Codex 复审）。统计「24h 内接了哪些单」
   * 看 acceptedAt + 非 cancelled/open，比 exposure 的「在途」口径更宽，专为模式检测。 */
  private computeAmlWindowTasks(input: EarningCycleInput): MarketplaceTask[] {
    const windowStart = this.deps.clock.now() - 86_400_000;
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = detail?.marketplaceTasks ?? [];
    return tasks.filter((t) => t.assigneePersonaId === input.personaId
      && (t.status === 'accepted' || t.status === 'completed')
      && (t.acceptedAt ?? 0) >= windowStart);
  }

  private categoryCompleted(input: EarningCycleInput, category: string): number {
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = detail?.marketplaceTasks ?? [];
    return tasks.filter((t) => t.category === category && t.status === 'completed' && t.assigneePersonaId === input.personaId).length;
  }

  private publisherIsNew(input: EarningCycleInput, publisherUserId: string): boolean {
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = detail?.marketplaceTasks ?? [];
    return !tasks.some((t) => t.publisherUserId === publisherUserId && t.assigneePersonaId === input.personaId);
  }

  /**
   * 近期连续失败数（熔断信号）：从该 persona 的任务历史统计 cancelled 任务
   * + completed 但 qualityScore 偏低（<0.4）的任务。这些代表"做砸/被取消"。
   * 用于 policy 的 failureStreakBreaker（连续失败则暂停 earning cycle）。
   */
  private recentFailureStreak(input: EarningCycleInput): number {
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = (detail?.marketplaceTasks ?? [])
      .filter((t) => t.assigneePersonaId === input.personaId)
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)); /* 最近在前 */
    let streak = 0;
    for (const t of tasks) {
      const failed = t.status === 'cancelled'
        || (t.status === 'completed' && (t.qualityScore ?? 1) < 0.4);
      if (failed) streak++;
      else if (t.status === 'completed') break; /* 遇到成功（高质量）则连续中断 */
    }
    return streak;
  }

  /**
   * AML/滥用 guard（ADR-0048 D1）：返回拦截原因（非空即拦），用于在准入前否决。
   * 覆盖：① 与该 publisher 争议/取消率过高 ② 同 publisher 异常重复低报酬刷单嫌疑。
   * （自接自发已在主循环单独拦截。）
   */
  private amlBlockReason(input: EarningCycleInput, task: MarketplaceTask): string | null {
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = (detail?.marketplaceTasks ?? []).filter((t) => t.publisherUserId === task.publisherUserId);
    if (tasks.length >= 3) {
      const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
      if (cancelled / tasks.length > 0.5) {
        return `publisher ${task.publisherUserId} 取消率过高 (${cancelled}/${tasks.length})`;
      }
    }
    return null;
  }
}

function emptyResult(): EarningCycleResult {
  return { scanned: 0, applied: 0, reviewQueued: 0, skipped: 0, outcomes: [] };
}
