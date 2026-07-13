/**
 * 确定性进修执行器（ADR-0057 进修闭环的零-LLM 生产驱动——闭合批评者指出的「死代码」缺口）。
 *
 * 缺口背景：ADR-0057 的 LearningOrchestratorL6（缺口→双老师互审→影子验收→落核→唤醒）组件齐全但
 * **生产零装配**——缺 candidate/examSpec 两个生产者，且完整版需两套独立 LLM 凭据（TeacherReviewGate
 * 独立性红线），单/无 key 部署跑不通。结果：任务因缺能力挂起后**永远醒不来**（没有后台在教它）。
 *
 * 本 service 提供一条**零-LLM 确定性主路**，让闭环在无任何 LLM 下也真正跑通：
 *   枚举 pending 学习请求 → generateDeterministicLearning 确定性产候选+考卷 → ShadowExamVerifier
 *   零-LLM 影子内核作答验收（≥95）→ 过则经蒸馏门 ingest 落核 + CAS pending→passed + emit
 *   capability-learned（下游 TaskWakeHandler 自动唤醒重跑那个挂起的任务）；不过 → CAS pending→failed。
 *
 * 与 LearningOrchestratorL6 的分工（不替代、不改它）：
 *   - L6 = 完整质量门（含双老师「该不该学」互审），配了两套独立 LLM 凭据的部署用它，最能查漏；
 *   - 本 service = 零-LLM 确定性底座，「该不该学」的职能相关性由 **GapDetector 已确定性保证**
 *     （capability 必在任务 requiredCapabilities 里才会登记学习请求，见 learning-request-service），
 *     「学会没」由零-LLM 影子验收保证——两道确定性闸门，不依赖外部老师，不碰 L6 红线代码。
 *
 * 铁律对齐：落核经同一 DistillationService（红线 2 不绕门）；CAS 状态推进（防并发重复学）；
 * emit 独立 try（监听器抛错不翻转已习得结局，对齐 L6）；确定性（注入 now()，非 Date.now()）。
 */

import { generateDeterministicLearning } from '@chrono/kernel';
import type { DistilledArtifact } from '@chrono/kernel';
import type { LearningRequestStore } from '../storage/learning-request-store.js';
import type { ShadowExamVerifier } from './shadow-exam-verifier.js';
import type { DistillationService } from './distillation-service.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'DeterministicLearningService';

/** 单条学习请求的处置结局（可审计）。 */
export type LearnResult =
  | { readonly kind: 'learned'; readonly learningRequestId: string; readonly personaId: string; readonly capability: string; readonly examScore: number }
  | { readonly kind: 'failed'; readonly learningRequestId: string; readonly reason: string }
  | { readonly kind: 'skipped'; readonly learningRequestId: string; readonly reason: string };

/** 一轮驱动的汇总统计。 */
export interface DriveStats {
  readonly considered: number;
  readonly learned: number;
  readonly failed: number;
  readonly skipped: number;
}

export class DeterministicLearningService {
  constructor(
    private readonly store: LearningRequestStore,
    private readonly verifier: ShadowExamVerifier,
    private readonly distillation: DistillationService,
    private readonly bus: EventBus,
    private readonly now: () => number,
    private readonly tenantId: string,
    private readonly logger?: Logger,
  ) {}

  /** 驱动一轮：枚举全部 pending 学习请求，逐条零-LLM 确定性教学+验收+落核。返回汇总。 */
  driveOnce(): DriveStats {
    const pending = this.store.listByStatus('pending');
    let learned = 0, failed = 0, skipped = 0;
    for (const req of pending) {
      const r = this.learnOne(req.id);
      if (r.kind === 'learned') learned += 1;
      else if (r.kind === 'failed') failed += 1;
      else skipped += 1;
    }
    if (pending.length > 0) {
      this.logger?.info(LAYER, `确定性进修一轮：考虑 ${pending.length}，学会 ${learned}，未过 ${failed}，跳过 ${skipped}`);
    }
    return { considered: pending.length, learned, failed, skipped };
  }

  /**
   * 处置单条学习请求（确定性）。account capability 唯一来源 = 账本（红线 7，非 candidate.kind）。
   * 全程 CAS 防并发：入口 pending→learning 抢占，末尾 learning→passed/failed。
   */
  learnOne(learningRequestId: string): LearnResult {
    const req = this.store.getById(learningRequestId);
    if (!req) return { kind: 'skipped', learningRequestId, reason: '学习请求不存在' };
    const { personaId, capability } = req;

    /* 入口 CAS：pending→learning。抢占失败 = 已被推进/并发 → skipped（不重复学）。 */
    if (!this.store.transitionStatus(req.id, 'pending', 'learning', this.now())) {
      return { kind: 'skipped', learningRequestId, reason: '非 pending（已被推进或并发处置）' };
    }

    /* 确定性产候选 + 考卷（自洽：学到的叙事含考点关键词 → 影子作答必命中 → ≥95）。 */
    const { candidate, examSpec } = generateDeterministicLearning({
      learningRequestId: req.id, capability, evidence: req.evidence, now: this.now(),
    });

    /* 零-LLM 影子验收（学会没）：候选编进影子核确定性作答 + 评分 + 回滚（不碰主内核）。 */
    const exam = this.verifier.verify(personaId, examSpec, candidate);
    if (!exam.ok) {
      this.fail(req.id);
      return { kind: 'failed', learningRequestId, reason: `影子验收异常/拒收: ${exam.reason}` };
    }
    if (!exam.passed) {
      this.fail(req.id);
      return { kind: 'failed', learningRequestId, reason: `验收未达标（coverage=${exam.examResult.coverage.toFixed(2)} < 0.95）` };
    }

    /* 蒸馏门正式落主内核（红线 2 不绕门、红线 8 各自 persona）。 */
    if (!this.land(personaId, candidate)) {
      this.fail(req.id);
      return { kind: 'failed', learningRequestId, reason: '蒸馏门落核失败（候选校验/编译被拒）' };
    }

    /* learning→passed（CAS）：passed = 可审计习得记录 + GapDetector「已学」来源。 */
    const learnedAt = this.now();
    if (!this.store.transitionStatus(req.id, 'learning', 'passed', learnedAt)) {
      /* 极罕见：learning 被并发改走。已落核（合法成长），不回滚，记 warn 供巡检。 */
      this.logger?.warn(LAYER, `落核后置 passed 失败（learning 被并发改走）: ${req.id}`);
      return { kind: 'failed', learningRequestId, reason: '落核成功但账本置 passed 失败（并发）' };
    }

    /* emit capability-learned（下游 TaskWakeHandler 唤醒挂起任务）。独立 try：监听器抛错不翻转已习得。 */
    try {
      this.bus.emit('capability-learned', {
        personaId, capability, learningRequestId: req.id, examScore: exam.examResult.coverage,
        learnedAt, tenantId: this.tenantId,
      });
    } catch (emitErr) {
      this.logger?.warn(LAYER, `capability-learned 监听器抛错（不影响已习得）: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`);
    }
    this.logger?.info(LAYER, `★确定性学会★ persona=${personaId} cap=${capability} score=${exam.examResult.coverage.toFixed(2)}`);
    return { kind: 'learned', learningRequestId, personaId, capability, examScore: exam.examResult.coverage };
  }

  /** learning→failed（CAS，释放幂等槽让未来可重试）。 */
  private fail(id: string): void {
    this.store.transitionStatus(id, 'learning', 'failed', this.now());
  }

  /**
   * 经蒸馏门把已 ≥95 影子验收的候选**真正落主内核**（红线 2 不绕门），照 LearningOrchestratorL6.land() 语义。
   *
   * ⚠️ 关键修复（Codex 交叉审查抓出的假 passed 致命问题）：narrative_patch 走 canAutoCompile 的 default
   * 分支恒返回 false → ingest 只入 pending（不自动编译）。若把 pending 当成功，会造成「账本 passed +
   * emit capability-learned + 任务被唤醒，但 persona 主内核叙事从未更新」的假学会。
   *
   * 正确：ingest 后若 pending（自动门未达/预算降级），对**已验收**候选显式 approve 强制落核——影子考试
   * ≥95 是比人工审批更强的成长门（程序化审批），不绕蒸馏门（approve 仍走 DistillationService 的校验/
   * 状态机/快照/compile 锁/编译器/审计）。只有真正 compiled（ingest 直接 compiled，或 approve 成功）才
   * 返回 true → 才推进 passed → 才 emit。rejected 或 approve 失败 → 落核失败，学习请求置 failed。
   */
  private land(personaId: string, candidate: DistilledArtifact): boolean {
    const res = this.distillation.ingest(personaId, {
      kind: candidate.kind, source: candidate.source, payload: candidate.payload,
      confidence: candidate.confidence, evidence: candidate.evidence,
    });
    if (res.status === 'compiled') return true;
    if (res.status === 'rejected') {
      this.logger?.warn(LAYER, `蒸馏门拒收候选: ${res.reason} [${res.problems.join('; ')}]`);
      return false;
    }
    /* pending：自动编译门未达/预算降级——已 ≥95 验收，显式 approve 强制落核（真 compiled 才算学会）。 */
    const approved = this.distillation.approve(personaId, res.artifact.id);
    if (!approved.ok) {
      this.logger?.warn(LAYER, `蒸馏门 approve 落核失败: ${approved.reason}`);
      return false;
    }
    return true;
  }
}
