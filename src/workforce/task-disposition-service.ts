/**
 * 任务缺口处置 service（ADR-0057 L8b）——遇能力缺口时「尽量不卡死」的确定性处置策略。
 *
 * 优先级（确定性，零-LLM，红线 20）：**委派 > 降级 > 挂起**。
 *   1. **委派**（首选）：组织内有学齐全部所需能力的同事 → 原子 CAS reassign 给 TA（任务保持 delegated 可执行，
 *      换人做、不等）。确定性选首个合格同事（CapabilityAssignmentService 稳定序）。
 *   2. **降级**（次选，**opt-in**）：无合格同事 + 任务允许降级 → 转 submitted + **结构化「[降级]」标注**
 *      （缺哪块、为什么、待进修后补齐）。**显式标注绝不假装完成**（红线：不静默假完成）——标记可审计 +
 *      仍登记学习请求（缺口异步补，下次可重跑做全）。默认**关**（保守）：未显式允许降级则不降级。
 *   3. **挂起**（兜底）：上两者都不行 → 不在此落地（交回执行门走 L8a 挂起 + 登记学习）。
 *
 * 与执行门解耦：execute() 在缺口门调本 service 决策；本 service 只做「委派/降级」两种**主动有产出**的处置，
 * 挂起仍由执行门（L8a 路径）落地——职责单一。委派/降级均**不**经审批门（组织内重指派/降级标注非对外执行风险，
 * 真执行由接手同事的执行门再过审批，ADR-0055 治理在那里施加）。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { CapabilityAssignmentService } from './capability-assignment-service.js';
import type { OrgTask } from './types.js';

/** 处置结局（确定性判别联合）。 */
export type DispositionOutcome =
  /** 已委派给有能力的同事（任务保持 delegated，换 TA 执行）。 */
  | { readonly kind: 'delegated'; readonly toWorkerId: string }
  /** 已降级完成（submitted + [降级] 标注，缺口仍异步学）。 */
  | { readonly kind: 'degraded'; readonly note: string }
  /** 无法委派/降级 → 交回执行门走挂起（L8a）。 */
  | { readonly kind: 'suspend' };

export interface DisposeInput {
  readonly orgId: string;
  readonly task: OrgTask;
  /** 当前执行者（委派 reassign 的 expectedCurrent，CAS 防陈旧）。 */
  readonly currentWorkerId: string;
  /** 本次缺的能力（用于降级标注）。 */
  readonly missingCapabilities: readonly string[];
}

export interface TaskDispositionDeps {
  readonly store: OrgWorkforceStore;
  readonly capabilities: CapabilityAssignmentService;
  readonly now: () => number;
  /**
   * 是否允许降级（opt-in，默认 false=保守不降级）。降级会把任务标 submitted（带 [降级] 标注），
   * 对「必须做全才算数」的任务可能不合适——故默认关，由调用方/任务策略显式开启。
   */
  readonly allowDegrade?: boolean;
}

export class TaskDispositionService {
  private readonly allowDegrade: boolean;

  constructor(private readonly deps: TaskDispositionDeps) {
    this.allowDegrade = deps.allowDegrade ?? false;
  }

  /**
   * 决策并落地处置：委派 → 降级 → 交回挂起。确定性（同库态 → 同结局）。
   * 委派/降级的 DB 写均 CAS/原子；并发抢走 → 退回 suspend（让执行门走 L8a，不强行覆盖）。
   */
  dispose(input: DisposeInput): DispositionOutcome {
    /* ① 委派：找学齐全部所需能力的同事（排除自己）。 */
    const colleague = this.deps.capabilities.findCapableColleague(
      input.orgId, input.task.requiredCapabilities, input.currentWorkerId,
    );
    if (colleague) {
      /* 原子 CAS reassign：仅当任务**仍 delegated 且仍由 currentWorkerId 持有**才改（防陈旧/并发拉起执行）。
       * 任务保持 delegated 可执行。抢不到（已被并发改派/拉起 in_progress）→ 退回 suspend（不强行覆盖）。 */
      if (this.deps.store.reassignDelegatedTaskIfHeldBy(input.orgId, input.task.id, input.currentWorkerId, colleague.id, this.deps.now())) {
        return { kind: 'delegated', toWorkerId: colleague.id };
      }
      return { kind: 'suspend' };
    }

    /* ② 降级（opt-in）：无合格同事 + 允许降级 → 标 submitted + 结构化 [降级] 标注（显式不假完成）。 */
    if (this.allowDegrade) {
      const caps = input.missingCapabilities.join(', ');
      const note = `[降级] 缺能力：${caps}——已完成可做部分，${caps} 相关部分待进修后补齐（未假装完成；已登记学习）`;
      /* CAS：仅当任务仍 delegated 才降级（防并发）。抢不到 → 退回 suspend。 */
      if (this.deps.store.transitionTaskExecutionIfStatus(input.orgId, input.task.id, 'delegated', 'submitted', note, this.deps.now())) {
        return { kind: 'degraded', note };
      }
      return { kind: 'suspend' };
    }

    /* ③ 兜底：交回执行门走 L8a 挂起。 */
    return { kind: 'suspend' };
  }
}
