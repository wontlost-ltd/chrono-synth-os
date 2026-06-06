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
import type { DecisionEngine } from './decision-engine.js';
import {
  evaluateEarningAdmission,
  DEFAULT_EARNING_POLICY,
  type EarningPolicyConfig,
  type EarningPersonaSnapshot,
  type EarningAdmission,
  type MarketplaceTask,
} from '@chrono/kernel';

const LAYER = 'PersonaEarningService';
const MARKETPLACE_TOOL_ID = 'marketplace.act';

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
}

export class PersonaEarningService {
  constructor(private readonly deps: PersonaEarningDeps) {}

  /**
   * 运行一个挣钱周期：扫描开放任务 → 对每个任务做匹配+确定性决策+准入门控 →
   * autonomous 准入且决策 accept 才经工具管线申请。返回每个任务的处置。
   */
  async runEarningCycle(input: EarningCycleInput): Promise<EarningCycleResult> {
    const policy = input.policy ?? DEFAULT_EARNING_POLICY;
    const maxTasks = Math.max(1, input.maxTasksPerCycle ?? 3);

    const persona = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') {
      this.deps.logger.info(LAYER, `挣钱周期跳过：persona 不存在或非 active (${input.personaId})`);
      return emptyResult();
    }

    const openTasks = this.deps.personaCore.listMarketplaceTasks(input.tenantId, 'open');
    const snapshot = this.buildPersonaSnapshot(input, persona);
    /* 今日已接单累计报酬（已接但未结算的任务报酬之和），用于每日暴露上限 */
    let todayExposure = this.computeTodayExposure(input);

    const outcomes: EarningCycleTaskOutcome[] = [];
    let applied = 0, reviewQueued = 0, skipped = 0;

    for (const task of openTasks.slice(0, maxTasks)) {
      /* 自己不能接自己发布的任务（AML/自接自发 guard 的第一道，policy 内还有更多） */
      if (task.publisherUserId === input.ownerUserId) {
        outcomes.push({ taskId: task.id, title: task.title, decision: 'skipped', reasons: ['cannot accept self-published task'] });
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

  /** 今日已接单累计报酬（accepted 状态任务的 reward 和） */
  private computeTodayExposure(input: EarningCycleInput): number {
    const detail = this.deps.personaCore.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    const tasks = detail?.marketplaceTasks ?? [];
    return tasks
      .filter((t) => t.assigneePersonaId === input.personaId && t.status === 'accepted')
      .reduce((sum, t) => sum + t.reward, 0);
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

  private recentFailureStreak(_input: EarningCycleInput): number {
    /* 失败/争议历史的精确统计在 E-5 接入 reputation history 后增强；
     * 当前以 0 起步（无失败记录），熔断仍由 policy 的其他硬约束保障。 */
    return 0;
  }
}

function emptyResult(): EarningCycleResult {
  return { scanned: 0, applied: 0, reviewQueued: 0, skipped: 0, outcomes: [] };
}
