/**
 * 学习请求 service（ADR-0057 L2）——把 L1 GapDetector 的缺口确定性登记成学习请求账本条目。
 *
 * 职责（确定性、零-LLM）：
 *   1. 幂等去重：同 (persona, capability) 已有 active（pending/learning）请求 → **不重复登记**（多挂起任务
 *      共享一次学习，防请教风暴，红线 9/D0.8）。
 *   2. unknown 标记：能力不在 KNOWN_CAPABILITIES 词表 → 标 isUnknown（typo 如 'reserch' 供人工归并，
 *      GapDetector 不自动猜，Codex L1 复审建议）。
 *   3. 已学能力来源：listLearnedCapabilities = 该 persona status=passed 的能力（L2 时代的「已学」，L7 正式化
 *      CapabilityIndex 后替换此来源）——供 GapDetector 算缺口差集。
 *
 * 本 service **不**做学习本身（双老师/验收在 L3-L6），只管「缺口 → 账本」这一步。
 */

import type { LearningRequestStore } from '../storage/learning-request-store.js';
import type { CapabilityIndexStore } from '../storage/capability-index-store.js';
import type { LearningRequest } from './types.js';
import { detectCapabilityGaps, isKnownCapability, type GapPriority } from '@chrono/kernel';

/** 单条缺口登记结果。 */
export interface RegisterGapOutcome {
  readonly capability: string;
  /** registered=新登记一条；deduped=已有 active 请求，复用未重复登记。 */
  readonly kind: 'registered' | 'deduped';
  readonly request: LearningRequest;
}

export class LearningRequestService {
  constructor(
    private readonly store: LearningRequestStore,
    private readonly now: () => number,
    private readonly idgen: () => string,
    private readonly tenantId: string = 'default',
    /**
     * ADR-0057 L7：能力索引（已学能力正式来源）。注入则**优先**读索引；为向后兼容（L7 前已有
     * passed 行但尚无索引行的现存租户），结果与 L2 passed 行**并集**——索引滞后不会让已学能力被误判未学。
     * 未注入 → 回退纯 L2 passed 扫描（旧调用方/测试，向后兼容）。
     */
    private readonly capabilityIndex?: CapabilityIndexStore,
  ) {}

  /**
   * 该 persona 已学会的能力——供 GapDetector 算缺口（persona-global）。
   * L7：优先 CapabilityIndex（正式来源）∪ L2 passed（向后兼容兜底；索引为新表，存量 passed 行无对应索引行）。
   * 并集**不引入假阳性**：两个来源都代表**真已通过学习**——索引由 L6 落核后的 capability-learned 事件写，
   * L2 passed 由真实状态机 learning→passed 推进。故并集只是补全（存量 passed 没索引行时不漏算），不会把
   * 「没学过」错算成「学过」。漏算的真实风险方向（投影滞后致索引缺该能力）由 L2 passed 兜底 + L2 active
   * 幂等防洪（漏算只是重登记，不重复请教）化解。确定性去重排序。
   */
  listLearnedCapabilities(personaId: string): string[] {
    const fromLedger = this.store.listPassedCapabilities(personaId);
    if (!this.capabilityIndex) return fromLedger;
    const fromIndex = this.capabilityIndex.listLearnedCapabilities(personaId);
    return [...new Set([...fromIndex, ...fromLedger])].sort();
  }

  /**
   * 检测并登记某任务对某 persona 的能力缺口（确定性闭环）：
   *   GapDetector(required − 已学) → 逐缺口幂等登记学习请求。
   * 返回每个缺口的登记结局（registered/deduped）。无缺口 → 空数组（调用方据此零-LLM 直接执行）。
   */
  detectAndRegister(input: {
    orgId: string;
    personaId: string;
    requiredCapabilities: readonly string[];
    taskId?: string;
    priority?: GapPriority;
  }): RegisterGapOutcome[] {
    const learned = this.listLearnedCapabilities(input.personaId);
    const detection = detectCapabilityGaps({
      requiredCapabilities: input.requiredCapabilities,
      personaLearnedCapabilities: learned,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.priority !== undefined ? { taskPriority: input.priority } : {}),
    });

    const outcomes: RegisterGapOutcome[] = [];
    for (const gap of detection.gaps) {
      outcomes.push(this.registerGap({
        orgId: input.orgId,
        personaId: input.personaId,
        capability: gap.capability,
        evidence: gap.evidence,
        priority: gap.priority,
        ...(input.taskId !== undefined ? { triggeredByTaskId: input.taskId } : {}),
      }));
    }
    return outcomes;
  }

  /** 登记单条缺口（幂等：已有 active 则复用不重复登记；并发由 DB 部分唯一索引兜底 + catch-and-refetch）。 */
  registerGap(input: {
    orgId: string;
    personaId: string;
    capability: string;
    evidence: string;
    priority: GapPriority;
    triggeredByTaskId?: string;
  }): RegisterGapOutcome {
    /* 幂等门：先查 active（pending/learning）——已有则复用，不重复请教（红线 9，persona-global）。 */
    const existing = this.store.findActive(input.personaId, input.capability);
    if (existing) {
      return { capability: input.capability, kind: 'deduped', request: existing };
    }
    const ts = this.now();
    const request: LearningRequest = {
      id: this.idgen(),
      tenantId: this.tenantId,
      orgId: input.orgId,
      personaId: input.personaId,
      capability: input.capability,
      /* unknown 标记：词表外能力（可能 typo），供人工归并（Codex L1 复审）。 */
      isUnknown: !isKnownCapability(input.capability),
      evidence: input.evidence,
      priority: input.priority,
      triggeredByTaskId: input.triggeredByTaskId ?? null,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };
    const { tenantId: _drop, ...row } = request;
    void _drop;
    try {
      this.store.insert(row);
      return { capability: input.capability, kind: 'registered', request };
    } catch (err) {
      /* 并发竞争：另一执行门已插入同 (persona, capability) active → DB 部分唯一索引拒绝本次插入。
       * catch-and-refetch：仅当**确为唯一约束冲突**时收敛——复用已存在的 active 请求返回 deduped（幂等，红线 9）。
       * 非唯一冲突的真错误（PK 碰撞 / DB 故障）**照抛**，不被吞（Codex L2 复审：错误分类 guard）。 */
      if (isActiveUniqueConflict(err)) {
        const won = this.store.findActive(input.personaId, input.capability);
        if (won) {
          return { capability: input.capability, kind: 'deduped', request: won };
        }
      }
      throw err;
    }
  }
}

/**
 * 是否为 active 部分唯一索引冲突（学习请求幂等竞争）——只认这一类冲突做 catch-and-refetch 收敛，
 * 其余约束/故障照抛。匹配该唯一索引名或通用 UNIQUE 冲突文案（SQLite/PG 措辞不同，兼容两者）。
 */
function isActiveUniqueConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /uq_learning_req_active_persona_cap/i.test(msg)
    || /UNIQUE constraint failed/i.test(msg)            /* SQLite */
    || /duplicate key value violates unique constraint/i.test(msg); /* PostgreSQL */
}
