/**
 * 能力匹配指派 service（ADR-0057 L8b）——确定性找「组织内已学齐某组能力的同事」。
 *
 * L8b 委派处置用：某数字员工遇能力缺口，想换个会的同事做 → 本 service 在**同组织**里找一个**人格已学齐
 * 全部所需能力**的 active 同事（排除自己）。纯确定性零-LLM（红线 20）：
 *   - 候选来源：org 内 active workers，按 listWorkers 的稳定序（created_at ASC, id ASC）。
 *   - 已学判定：复用 LearningRequestService.listLearnedCapabilities（= CapabilityIndex ∪ L2 passed）——
 *     **与 GapDetector 同一「已学」来源**，保证「这个同事不会再撞缺口门」与判定一致。
 *   - 选择：第一个学齐全部所需能力的同事（稳定序→可复现）；无 → null。
 *
 * 不绑死任何组织层级规则（不限直接下属/上级）——这是「同组织任意有能力同事」的系统自动确定性指派，
 * 非人工 org-chart 委派协商（与 handoff propose/accept 区分）。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { LearningRequestService } from './learning-request-service.js';
import type { DigitalWorker } from './types.js';
import { normalizeCapability } from '@chrono/kernel';

export class CapabilityAssignmentService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly learning: LearningRequestService,
  ) {}

  /**
   * 找一个**学齐全部 requiredCapabilities** 的 active 同事（排除 excludeWorkerId）。
   * 稳定序取首个；无合格同事 → null。确定性可复现（同库态 → 同结果）。
   */
  findCapableColleague(orgId: string, requiredCapabilities: readonly string[], excludeWorkerId: string): DigitalWorker | null {
    if (requiredCapabilities.length === 0) return null;
    const need = new Set(requiredCapabilities.map(normalizeCapability));

    /* listWorkers 已按 created_at ASC, id ASC 稳定排序——确定性选首个合格同事。 */
    for (const worker of this.store.listWorkers(orgId)) {
      if (worker.id === excludeWorkerId) continue;
      if (worker.employmentStatus !== 'active') continue;
      /* 该同事人格已学能力（与 GapDetector 同源：CapabilityIndex ∪ L2 passed）。 */
      const learned = new Set(this.learning.listLearnedCapabilities(worker.personaId).map(normalizeCapability));
      /* 必须学齐**全部**所需能力（任缺一项即不合格——否则委派过去仍撞缺口门）。 */
      let coversAll = true;
      for (const cap of need) {
        if (!learned.has(cap)) { coversAll = false; break; }
      }
      if (coversAll) return worker;
    }
    return null;
  }
}
