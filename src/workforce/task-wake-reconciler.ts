/**
 * 任务唤醒对账器 TaskWakeReconciler（ADR-0057 L8c）——唤醒可靠性兜底。
 *
 * capability-learned 事件是 best-effort（EventBus 可能丢投），仅靠 L8a 事件驱动唤醒可能让任务在「其实已学会」
 * 时仍永久挂起。本对账器**确定性反扫**所有 blocked 任务，对每个复检已学能力（GapDetector）——已学齐则
 * 补唤醒（复用 L8a 同一套 wakeOneTask 核心，不漂移），把「事件丢失」从「永久挂起」降级为「至多延迟到下次反扫」。
 *
 * 另含**学习超时兜底**：长期挂起（学习迟迟不过：连续验收不过/老师退回/预算耗尽）的任务标记 [learning_timeout]
 * （仍 blocked，待人工/改委派），防无限挂起。
 *
 * 守红线 20（全程零-LLM 确定性）：反扫 + GapDetector 复检 + 超时比较全确定性。无新推理循环、无 LLM。
 * 失败隔离：单任务处理异常只记 error 继续下一个（一个坏任务不阻断整轮对账）。
 *
 * 触发：本片提供**按需** reconcileOnce(orgId, now)——可测（无需真实定时器）。生产周期触发（接入既有
 * sweep/定时器）是部署接线，不在本片（与 QuotaUsageRetentionWorker 等既有周期 worker 同接法，后续接入）。
 *
 * 幂等（关键）：reconciler 用**合成 wakeEventId**（绑该 persona 当前已学能力指纹）——同一已学状态下重复反扫
 * 生成同 id → wakeOneTask 经 lastWakeEventId 幂等跳过，**不重复推进尝试计数/不重复唤醒**；学习状态变了
 * （新学一项）id 才变，才会再尝试。这样周期反扫不会烧光 resumeAttemptCount 预算。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { LearningRequestService } from './learning-request-service.js';
import type { TaskWakeHandler, TaskWakeOutcome } from './task-wake-handler.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'TaskWakeReconciler';

/** 默认学习超时（挂起多久仍未学会就标超时兜底）：7 天。 */
const DEFAULT_LEARNING_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** 单轮对账统计（审计/测试）。 */
export interface ReconcileStats {
  /** 反扫的 blocked 任务数。 */
  readonly scanned: number;
  /** 补唤醒成功（blocked→delegated）数。 */
  readonly woke: number;
  /** 复检仍缺 / 超上限 / 幂等跳过等（未唤醒）数。 */
  readonly stillBlocked: number;
  /** 标记学习超时数。 */
  readonly timedOut: number;
  /** 各任务唤醒结局（审计）。 */
  readonly outcomes: readonly TaskWakeOutcome[];
}

export interface TaskWakeReconcilerDeps {
  readonly store: OrgWorkforceStore;
  readonly learning: LearningRequestService;
  /** 复用 L8a 唤醒核心（wakeOneTask）——事件驱动与反扫驱动共享同一确定性逻辑。 */
  readonly wakeHandler: TaskWakeHandler;
  readonly logger: Logger;
  readonly now: () => number;
  /** 学习超时阈值（可选；默认 7 天）。 */
  readonly learningTimeoutMs?: number;
}

export class TaskWakeReconciler {
  private readonly learningTimeoutMs: number;

  constructor(private readonly deps: TaskWakeReconcilerDeps) {
    this.learningTimeoutMs = deps.learningTimeoutMs ?? DEFAULT_LEARNING_TIMEOUT_MS;
  }

  /**
   * 反扫某 org 全部 blocked 任务：复检已学能力补唤醒（防丢事件永久挂起）+ 学习超时兜底。
   * 确定性可复现（同库态 → 同结局）。按需调用（测试无需定时器）。
   */
  reconcileOnce(orgId: string, now = this.deps.now()): ReconcileStats {
    /* **只反扫因学习缺口挂起的任务**（有关联 learning_requests）——非学习 blocked（工具失败/权限/异常）
     * 绝不纳入，否则会被误唤醒/误标超时覆盖真实失败原因（Codex L8c 复审）。 */
    const blocked = this.deps.store.listLearningBlockedTasks(orgId);
    let woke = 0; let stillBlocked = 0; let timedOut = 0;
    const outcomes: TaskWakeOutcome[] = [];

    for (const task of blocked) {
      try {
        /* 该任务执行者人格（per-persona 已学来源）。无执行者（理论不应）→ 跳过。 */
        const personaId = this.personaIdOfTask(orgId, task.assignedToWorkerId);
        if (!personaId) continue;

        /* 合成幂等键：绑该 persona 当前已学能力指纹——已学状态不变则同 id（重复反扫幂等跳过，不烧预算）；
         * 学一项新能力 id 才变才会再尝试。用 JSON.stringify 而非 join(',')，消除能力名含分隔符的碰撞风险
         * （Codex L8c 复审）。listLearnedCapabilities 已排序去重，故指纹确定性。 */
        const learned = this.deps.learning.listLearnedCapabilities(personaId);
        const wakeEventId = `reconcile:${personaId}:${JSON.stringify(learned)}`;

        const outcome = this.deps.wakeHandler.wakeOneTask(orgId, task.id, personaId, wakeEventId);
        outcomes.push(outcome);
        if (outcome.kind === 'woke') woke++;
        else stillBlocked++;

        /* 学习超时兜底：仍 blocked（未唤醒）且挂起过久 → 标 [learning_timeout]（仍 blocked 待人工/改委派）。
         * 用 updatedAt 作挂起基线（最后一次状态变更=进 blocked 时刻；唤醒尝试也会刷新它，故是「最近活动」起算）。 */
        if (outcome.kind !== 'woke' && now - task.updatedAt > this.learningTimeoutMs) {
          if (this.deps.store.markBlockedTaskLearningTimeout(orgId, task.id, `[learning_timeout] 挂起超 ${Math.round(this.learningTimeoutMs / 86_400_000)} 天未学会，待人工/改委派`, now)) {
            timedOut++;
            this.deps.logger.warn(LAYER, `任务 ${task.id} 学习超时，已标记待人工兜底`);
          }
        }
      } catch (err) {
        /* 单任务异常隔离：记 error 继续下一个（一个坏任务不阻断整轮对账）。 */
        this.deps.logger.error(LAYER, `对账任务 ${task.id} 异常（已隔离，继续）: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (woke > 0 || timedOut > 0) {
      this.deps.logger.info(LAYER, `对账 org=${orgId}：扫 ${blocked.length}，唤醒 ${woke}，超时 ${timedOut}`);
    }
    return { scanned: blocked.length, woke, stillBlocked, timedOut, outcomes };
  }

  /** 取任务执行者绑定的人格内核 id；无执行者/worker → ''。 */
  private personaIdOfTask(orgId: string, assignedToWorkerId: string | null): string {
    if (!assignedToWorkerId) return '';
    const worker = this.deps.store.getWorker(orgId, assignedToWorkerId);
    return worker?.personaId ?? '';
  }
}
