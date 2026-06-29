/**
 * 任务唤醒处理器 TaskWakeHandler（ADR-0057 L8a，D0.8 核心闭环）——「学完马上投入工作」的临门一脚。
 *
 * 订阅 L6 的 capability-learned 事件（某 persona 学会某能力，已落核）→ 找因该 (persona, capability) 缺口而
 * **挂起（blocked）**的任务 → 对每个任务**确定性复检** → 无缺口则唤醒重跑（blocked→delegated，零-LLM）；
 * 仍有缺口则 **fail-closed**（保持 blocked）。
 *
 * 守 D0.8 红线 20（全程零-LLM，确定性策略 + 确定性事件门控）：
 *   - **事件只标 resolved 不直接执行**：唤醒只把任务推回 delegated（重新可执行），**不**在此调工具/执行——
 *     重跑由正常执行门（WorkerExecutionService.execute）接手（那里再过一遍缺口门，已无缺口才真执行）。
 *   - **重跑前必须再跑确定性 GapDetector 复检**（经 LearningRequestService.detectAndRegister 的纯检测路径）：
 *     某任务 requiredCapabilities 在该 persona 已学能力（CapabilityIndex ∪ L2 passed）下**全部满足**才唤醒；
 *     **仍有缺口**（学的与任务实际需要不完全匹配 / 多能力只学了一个）→ **保持 blocked，绝不静默执行/假完成**。
 *   - **防死循环**：resumeAttemptCount 上限——超限不再唤醒（停 blocked，留 SLA/人工兜底）；lastWakeEventId
 *     幂等去重——EventBus 重复投递同一事件不重复推进/重复唤醒。
 *   - **per-persona 隔离**（红线 8/15）：找挂起任务、算已学能力全 (tenant, persona) 限定。
 *
 * 失败隔离（对齐 CapabilityIndexProjector / NudgePushBridge）：订阅回调**绝不抛进 bus.emit**——唤醒异常只记
 * error，不污染触发它的学习主流程（学习已落核 + 账本 passed，唤醒是下游派生）。
 *
 * 范围（L8a）：本片只做**挂起→唤醒→复检→重跑就绪**核心闭环。委派/降级处置（L8b）、reconciler 防事件丢失
 * （L8c）留后续切片（ADR 登记）。
 */

import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { LearningRequestService } from './learning-request-service.js';
import { detectCapabilityGaps } from '@chrono/kernel';

const LAYER = 'TaskWakeHandler';

/** 默认唤醒尝试上限（防多能力误唤醒/死循环；超限停 blocked 留兜底）。 */
const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

/** capability-learned 事件载荷（与 SystemEventMap 同形）。 */
interface CapabilityLearnedPayload {
  readonly tenantId?: string;
  readonly personaId?: string;
  readonly capability?: string;
  readonly learningRequestId?: string;
  readonly examScore?: number;
  readonly learnedAt?: number;
}

export interface TaskWakeHandlerDeps {
  readonly bus: EventBus;
  /** 该 tenant 的 workforce store（找挂起任务 + CAS 唤醒）。 */
  readonly store: OrgWorkforceStore;
  /** 学习请求 service（listLearnedCapabilities = CapabilityIndex ∪ L2，复检已学能力来源）。 */
  readonly learning: LearningRequestService;
  readonly logger: Logger;
  readonly now: () => number;
  /** 本 handler 服务的租户（事件 tenantId 必须匹配，防跨租户唤醒）。 */
  readonly tenantId: string;
  /** 唤醒尝试上限（可选；默认 3）。 */
  readonly maxResumeAttempts?: number;
}

/** 单任务唤醒结局（审计/测试用）。 */
export type TaskWakeOutcome =
  | { readonly kind: 'woke'; readonly taskId: string }            /* 复检无缺口 → blocked→delegated 重跑就绪 */
  | { readonly kind: 'still_blocked'; readonly taskId: string; readonly remainingGaps: readonly string[] } /* 复检仍缺 → fail-closed */
  | { readonly kind: 'attempts_exhausted'; readonly taskId: string } /* 超尝试上限 → 停 blocked */
  | { readonly kind: 'skipped_idempotent'; readonly taskId: string } /* 同事件已处理 → 幂等跳过 */
  | { readonly kind: 'lost_race'; readonly taskId: string };      /* CAS 未抢到（已被并发改走） */

export class TaskWakeHandler {
  private listener: ((payload: CapabilityLearnedPayload) => void) | null = null;
  private readonly maxResumeAttempts: number;

  constructor(private readonly deps: TaskWakeHandlerDeps) {
    this.maxResumeAttempts = deps.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
  }

  start(): void {
    if (this.listener) return;
    this.listener = (payload) => this.onLearned(payload);
    this.deps.bus.on('capability-learned', this.listener as never);
  }

  stop(): void {
    if (this.listener) {
      this.deps.bus.off('capability-learned', this.listener as never);
      this.listener = null;
    }
  }

  /** 同步入口：校验 → 唤醒挂起任务。失败隔离（绝不抛进 bus.emit）。返回各任务结局（审计/测试）。 */
  onLearned(payload: CapabilityLearnedPayload): TaskWakeOutcome[] {
    /* 红线 7/8：缺 tenantId / 非本租户 → drop（不跨租户唤醒）。 */
    if (typeof payload.tenantId !== 'string' || payload.tenantId !== this.deps.tenantId
      || typeof payload.personaId !== 'string'
      || typeof payload.capability !== 'string'
      || typeof payload.learningRequestId !== 'string') {
      return [];
    }
    const { personaId, capability, learningRequestId } = payload;
    try {
      const blocked = this.deps.store.listBlockedTasksForLearnedCapability(personaId, capability);
      const outcomes: TaskWakeOutcome[] = [];
      for (const task of blocked) {
        outcomes.push(this.wakeOneTask(task.orgId, task.id, personaId, learningRequestId));
      }
      return outcomes;
    } catch (err) {
      this.deps.logger.error(LAYER, `任务唤醒失败（已隔离，不影响已习得）: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 单任务唤醒核心（确定性，零-LLM）：幂等检查 → 尝试上限 → GapDetector 复检 → 无缺口唤醒 / 仍缺 fail-closed。
   * **公开**供 L8c reconciler 复用同一套唤醒逻辑（事件驱动 L8a 与 sweep 驱动 L8c 共享，不漂移）——
   * 唯一区别是 wakeEventId 来源：事件驱动用 learningRequestId，reconciler 用合成 id（幂等键）。
   */
  wakeOneTask(orgId: string, taskId: string, personaId: string, wakeEventId: string): TaskWakeOutcome {
    /* 重读最新任务（listBlocked 与处理间可能已变）。 */
    const task = this.deps.store.getTask(orgId, taskId);
    if (!task || task.status !== 'blocked') return { kind: 'lost_race', taskId };

    /* 幂等：同一唤醒事件已处理过该任务 → 跳过（EventBus 重复投递防护）。 */
    if (task.lastWakeEventId === wakeEventId) return { kind: 'skipped_idempotent', taskId };

    /* 防死循环：超尝试上限 → 不再唤醒（停 blocked，留 SLA/人工兜底）。仍记一次（推进计数 + 记事件）。
     * CAS 未命中（任务已被并发改走）→ lost_race（不误报 attempts_exhausted，Codex L8a 复审）。 */
    if (task.resumeAttemptCount >= this.maxResumeAttempts) {
      if (!this.deps.store.recordWakeAttemptOnBlocked(orgId, taskId, `唤醒尝试超上限(${this.maxResumeAttempts})，停在 blocked 待人工/SLA 兜底`, wakeEventId, this.deps.now())) {
        return { kind: 'lost_race', taskId };
      }
      this.deps.logger.warn(LAYER, `任务 ${taskId} 唤醒尝试超上限，停 blocked`);
      return { kind: 'attempts_exhausted', taskId };
    }

    /* 红线 20 关键守卫：**重跑前再跑确定性 GapDetector 复检**——任务全部所需能力在该 persona 已学
     * （CapabilityIndex ∪ L2 passed）下满足才唤醒。仍缺（多能力只学一个/学的与需要不匹配）→ fail-closed。 */
    const learned = this.deps.learning.listLearnedCapabilities(personaId);
    const detection = detectCapabilityGaps({
      requiredCapabilities: task.requiredCapabilities,
      personaLearnedCapabilities: learned,
      taskId,
    });

    if (detection.hasGap) {
      /* 仍有缺口 → 保持 blocked（绝不静默执行/假完成），推进计数 + 记事件（防死循环 + 审计）。
       * CAS 未命中（已被并发改走）→ lost_race（不误报 still_blocked，Codex L8a 复审）。 */
      const remaining = detection.gaps.map((g) => g.capability);
      if (!this.deps.store.recordWakeAttemptOnBlocked(orgId, taskId, `复检仍缺能力：${remaining.join(', ')}（保持挂起）`, wakeEventId, this.deps.now())) {
        return { kind: 'lost_race', taskId };
      }
      this.deps.logger.info(LAYER, `任务 ${taskId} 复检仍缺 [${remaining.join(', ')}]，fail-closed 保持 blocked`);
      return { kind: 'still_blocked', taskId, remainingGaps: remaining };
    }

    /* 无缺口 → 唤醒重跑（blocked→delegated，CAS）。零-LLM：只推回可执行态，真执行由正常执行门接手。 */
    if (!this.deps.store.wakeBlockedTaskToDelegated(orgId, taskId, '已学齐所需能力，唤醒重跑（待执行门接手）', wakeEventId, this.deps.now())) {
      return { kind: 'lost_race', taskId };
    }
    this.deps.logger.info(LAYER, `★唤醒重跑★ 任务 ${taskId}（persona=${personaId} 已学齐 [${task.requiredCapabilities.join(', ')}]）`);
    return { kind: 'woke', taskId };
  }
}
