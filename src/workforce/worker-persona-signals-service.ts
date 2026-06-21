/**
 * 数字员工人格信号 service（C2：把安全的类人化信号接到 worker）。
 *
 * 在 C0（运行健康）+ C1（per-counterpart 协作记忆）之上，产出 worker 的**企业语言人格信号束**——
 * 蓝图的「类人化信号是资产、表演是负债」B 端翻译，全确定性零-LLM，不走 companion：
 *   - decisionConfidence（stance→可解释决策置信度）：由交付记录确定性派生（交付多/无阻塞高风险 → high）。
 *   - collaborationReach（relationship→协作广度）：协作过多少个不同对手方（来自 C1，per-counterpart 无串味）。
 *   - shouldReport（proactive→主动汇报标记）：有阻塞或高风险在手 → 该主动汇报/升级（确定性，非情绪）。
 *
 * 这不是「心情/迟疑表演」，是管理者可用的运营人格信号。相同状态 → 相同信号（可复现）。
 */

import type { WorkerSignalsService, WorkerOperatingSignal } from './worker-signals-service.js';
import type { WorkerCollaborationMemoryStore } from '../storage/worker-collaboration-memory-store.js';

/** 决策置信度（stance 的 B 端形态：可解释，非情绪）。 */
export type DecisionConfidence = 'high' | 'medium' | 'low';

/** worker 人格信号束（企业运营视图）。 */
export interface WorkerPersonaSignal {
  readonly workerId: string;
  /** 决策置信度：交付记录 + 当前是否有阻塞/高风险确定性派生。 */
  readonly decisionConfidence: DecisionConfidence;
  /** 决策置信度的可解释依据（哪些事实导致这个置信度）。 */
  readonly confidenceRationale: string;
  /** 协作广度：协作过的不同对手方数量（C1，无串味）。 */
  readonly collaborationReach: number;
  /** 是否该主动汇报/升级（有阻塞或高风险在手）。 */
  readonly shouldReport: boolean;
  /** 底层运行信号（C0，透传供上层用）。 */
  readonly operating: WorkerOperatingSignal;
}

/** 算 high 置信度的最低交付数。 */
const HIGH_CONFIDENCE_DELIVERED = 3;

export class WorkerPersonaSignalsService {
  constructor(
    private readonly signals: WorkerSignalsService,
    private readonly collab: WorkerCollaborationMemoryStore,
  ) {}

  /**
   * 算一个 worker 的人格信号束（确定性，零-LLM）。worker 不存在 → undefined。
   * 复用 C0 运行信号 + C1 协作记忆，纯派生不新写库。
   */
  getPersonaSignal(orgId: string, workerId: string): WorkerPersonaSignal | undefined {
    const operating = this.signals.getOperatingSignal(orgId, workerId);
    if (!operating) return undefined;

    /* 决策置信度（确定性）：有阻塞/高风险在手 → low（先解决再说硬话）；交付多且干净 → high；其余 medium。 */
    let decisionConfidence: DecisionConfidence;
    let confidenceRationale: string;
    if (operating.needsAttention) {
      decisionConfidence = 'low';
      confidenceRationale = operating.blockedTaskCount > 0
        ? `有 ${operating.blockedTaskCount} 个阻塞任务，建议先解阻塞`
        : `有 ${operating.highRiskTaskCount} 个高风险在手任务，需谨慎并按需升级`;
    } else if (operating.deliveredTaskCount >= HIGH_CONFIDENCE_DELIVERED) {
      decisionConfidence = 'high';
      confidenceRationale = `已稳定交付 ${operating.deliveredTaskCount} 个任务，无阻塞/高风险`;
    } else {
      decisionConfidence = 'medium';
      confidenceRationale = `交付记录尚浅（${operating.deliveredTaskCount} 个），无阻塞/高风险`;
    }

    return {
      workerId,
      decisionConfidence,
      confidenceRationale,
      collaborationReach: this.collab.listForWorker(orgId, workerId).length,
      /* 主动汇报标记 = 需关注（有阻塞或高风险）。这是 proactive 的 B 端形态：该主动升级而非沉默。 */
      shouldReport: operating.needsAttention,
      operating,
    };
  }
}
