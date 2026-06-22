/**
 * 重组建议 service——据**确定性运行信号**生成重组**建议**（不自动执行，人类确认后才调执行 API）。
 *
 * 守愿景红线：建议是**确定性信号 → 候选清单**（零-LLM，无推理判断「该不该」），决策权留人类。系统绝不
 * 自动 reparent/offboard/absorb——只回答「据负载/健康信号，这些 worker 可能值得关注」，附确定性理由。
 *
 * 信号源：WorkerSignalsService（C0：load=idle/normal/heavy + 在手/逾期/阻塞/高风险计数，纯函数零-LLM）。
 * 只看 **active** worker（offboarded/suspended 不在建议范围）。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import { WorkerSignalsService } from './worker-signals-service.js';

/** 一条重组建议（确定性，人类确认后才执行）。 */
export interface RestructureSuggestion {
  readonly kind: 'offboard_idle' | 'redistribute_overloaded';
  readonly workerId: string;
  readonly displayName: string;
  /** 确定性理由（据信号派生，可审计）。 */
  readonly reason: string;
  /** 建议关联的执行动作（前端引导，不自动跑）。 */
  readonly suggestedAction: 'offboard' | 'reparent' | 'hire';
}

export class RestructureSuggestionsService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
  ) {}

  /**
   * 生成某组织的重组建议（确定性）：
   *   - 长期空闲（load=idle 且无产出）的 active worker → 建议 offboard/重分配（精简）。
   *   - 过载（load=heavy 且 needsAttention）的 worker → 建议 redistribute/hire（扩容/分流）。
   * 只看 active worker；确定性排序（worker 创建序，listWorkers 已排）。
   */
  suggest(orgId: string): RestructureSuggestion[] {
    const signals = new WorkerSignalsService(this.store, this.now);
    const out: RestructureSuggestion[] = [];
    for (const w of this.store.listWorkers(orgId)) {
      if (w.employmentStatus !== 'active') continue;  /* 只建议 active worker */
      const sig = signals.getOperatingSignal(orgId, w.id);
      if (!sig) continue;
      /* 空闲：无在手、无产出 → 精简候选。 */
      if (sig.load === 'idle' && sig.activeTaskCount === 0 && sig.deliveredTaskCount === 0) {
        out.push({
          kind: 'offboard_idle', workerId: w.id, displayName: w.displayName,
          reason: '长期空闲（无在手任务、无已交付产出）',
          suggestedAction: 'offboard',
        });
      } else if (sig.load === 'heavy' && sig.needsAttention) {
        /* 过载且需关注（阻塞/高风险/逾期）→ 分流/扩容候选。 */
        out.push({
          kind: 'redistribute_overloaded', workerId: w.id, displayName: w.displayName,
          reason: `过载需关注（在手 ${sig.activeTaskCount}、阻塞 ${sig.blockedTaskCount}、逾期 ${sig.overdueTaskCount}、高风险 ${sig.highRiskTaskCount}）`,
          suggestedAction: 'hire',
        });
      }
    }
    return out;
  }
}
