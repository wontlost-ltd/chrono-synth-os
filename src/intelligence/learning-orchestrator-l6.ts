/**
 * 学习编排器 LearningOrchestratorL6（ADR-0057 L6）——把 L1-L5 的零件串成**完整闭环**的临门一脚。
 *
 * 一条学习请求（L2 账本 pending）的端到端处置：
 *   ① L5 双老师互审门（该不该学）→ ② L4 影子验收（确定性内核能不能答 ≥95）→ ③ L6 蒸馏门**正式落主内核**
 *   → ④ L2 账本状态推进（pending→learning→passed/failed）→ ⑤ 发 capability-learned 事件（供 L8 唤醒）。
 *
 * 守零-LLM 铁律（红线 1）：本编排器**运行时不调 LLM**——LLM 只在 L5 老师审「该不该学」时出现（学习期）；
 * 验收（L4）与落核（L6）全确定性。学到的知识经**同一蒸馏门**（DistillationService.ingest，红线 2 不绕门）
 * 落**各自 persona** 主内核（红线 8 per-persona）。
 *
 * 状态机纪律（CAS，防并发覆盖）：
 *   - 入口 pending→learning：抢占失败（已被另一执行推进）→ 直接返回 skipped，不重复学。
 *   - 任一阶段不过（L5 退回 / L4 <95 / L6 ingest 拒）→ learning→failed（释放 active 幂等槽，红线 9）。
 *   - 全过 → learning→passed（passed 即本次习得的可审计记录，L7 CapabilityIndex 前的「已学」来源）。
 *
 * capability 口径（红线 7）：**取自 L2 账本条目**（真实缺口能力），不取 candidate.kind——职能相关性前置筛
 * 与 capability-learned 事件都引这一来源，避免「按 kind 而非真实能力」的错配。
 *
 * 落核 vs 待审批：ingest 满足自动编译门即落主内核；若被不确定性预算降级为 pending，本编排器对**已 ≥95 验收**
 * 的候选显式 approve 强制落核（验收已是更强的成长门，不让预算静默丢弃已证明学会的能力）。ingest 真拒（校验
 * 失败）才算 failed。
 */

import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import type { LearningRequestStore } from '../storage/learning-request-store.js';
import type { TeacherReviewGate, TeacherReviewResult } from './teacher-review-gate.js';
import type { ShadowExamVerifier } from './shadow-exam-verifier.js';
import type { DistillationService, CandidateInput } from './distillation-service.js';
import {
  type DistilledArtifact, type ExamSpec, type JobFunctionContext,
} from '@chrono/kernel';

/** L6 编排输入：一条学习请求 + 其候选知识 + 验收题 + 职能上下文。 */
export interface LearnOrchestrationInput {
  /** L2 账本条目 id（驱动状态推进）。 */
  readonly learningRequestId: string;
  /** 候选知识工件（学习期由老师教学产出；L6 验收 + 落核的对象）。 */
  readonly candidate: DistilledArtifact;
  /** 该能力的验收题（双老师拟题后冻结，L4 用）。 */
  readonly examSpec: ExamSpec;
  /** 职能上下文（L5 确定性相关性前置筛）。 */
  readonly jobContext: JobFunctionContext;
}

/** 编排退回阶段（审计；对齐 L2 账本 + 红线诊断）。 */
export type LearnFailStage = 'precheck' | 'exam_mismatch' | 'l5_review' | 'l4_exam' | 'l6_ingest';

/** 编排结局。 */
export type LearnOrchestrationOutcome =
  | { readonly ok: true; readonly personaId: string; readonly capability: string; readonly examScore: number; readonly learnedAt: number }
  /** 入口 CAS 抢占失败（已被另一执行推进/已非 pending）——非失败，不重复学。 */
  | { readonly ok: false; readonly skipped: true; readonly reason: string }
  /** 某阶段退回（L2 已置 failed）。 */
  | { readonly ok: false; readonly skipped: false; readonly stage: LearnFailStage; readonly reason: string; readonly review?: TeacherReviewResult };

const LAYER = 'LearningOrchestratorL6';

export class LearningOrchestratorL6 {
  constructor(
    private readonly store: LearningRequestStore,
    private readonly teacherGate: TeacherReviewGate,
    private readonly verifier: ShadowExamVerifier,
    private readonly distillation: DistillationService,
    private readonly bus: EventBus,
    private readonly now: () => number,
    private readonly tenantId: string = 'default',
    private readonly logger?: Logger,
  ) {}

  /**
   * 端到端处置一条学习请求：L5 互审 → L4 验收 → L6 落核 → 推进账本 + 发事件。
   * 确定性可复现（同输入 + 同老师 verdict → 同结局）。运行时零-LLM（LLM 只在 L5 老师审）。
   */
  async orchestrate(input: LearnOrchestrationInput): Promise<LearnOrchestrationOutcome> {
    /* ① 取账本条目——capability 的**唯一可信来源**（真实缺口，非 candidate.kind，红线 7）。 */
    const request = this.store.getById(input.learningRequestId);
    if (!request) {
      return { ok: false, skipped: false, stage: 'precheck', reason: `学习请求不存在: ${input.learningRequestId}` };
    }
    const { personaId, capability } = request;

    /* ② 入口 CAS：pending→learning。抢占失败 = 已被另一执行推进/已非 pending → skipped（不重复学）。 */
    if (!this.store.transitionStatus(request.id, 'pending', 'learning', this.now())) {
      this.logger?.info(LAYER, `学习请求非 pending（已被推进/并发），跳过: ${request.id}`);
      return { ok: false, skipped: true, reason: '学习请求非 pending（已被推进或并发处置）' };
    }

    try {
      /* ③ 确定性绑定校验（Codex L6 复审，闭环完整性）：验收题必须**正考本能力**——examSpec.capability 须等于账本
       *    capability。否则可用「另一项能力的考卷」让 L4 误判 passed，把账本能力错标 learned（破闭环证明）。
       *    传错考卷 = 本次学习材料无效 → failed（释放幂等槽）。纯确定性，零-LLM。 */
      if (input.examSpec.capability !== capability) {
        this.fail(request.id);
        this.logger?.warn(LAYER, `验收题能力不匹配 req=${capability} exam=${input.examSpec.capability}`);
        return {
          ok: false, skipped: false, stage: 'exam_mismatch',
          reason: `验收题能力不匹配（request=${capability}, exam=${input.examSpec.capability}），学习材料无效`,
        };
      }

      /* ④ L5 双老师互审门（该不该学）：确定性前置筛 + 两老师 blind 初审 + AND 合并。退回 → failed。 */
      const review = await this.teacherGate.review({ capability, candidate: input.candidate, context: input.jobContext });
      if (!review.decision.approved) {
        this.fail(request.id);
        this.logger?.info(LAYER, `L5 互审退回 cap=${capability} stage=${review.decision.stage}`);
        return { ok: false, skipped: false, stage: 'l5_review', reason: review.decision.rejectReason ?? '老师退回', review };
      }

      /* ⑤ L4 影子验收（确定性内核能不能答 ≥95）：候选编进影子核作答评分 + 回滚（不碰主内核）。<95 → failed。 */
      const exam = this.verifier.verify(personaId, input.examSpec, input.candidate);
      if (!exam.ok) {
        this.fail(request.id);
        return { ok: false, skipped: false, stage: 'l4_exam', reason: `影子验收异常/拒收: ${exam.reason}` };
      }
      if (!exam.passed) {
        this.fail(request.id);
        this.logger?.info(LAYER, `L4 验收未达 95 cap=${capability} coverage=${exam.examResult.coverage.toFixed(2)}`);
        return { ok: false, skipped: false, stage: 'l4_exam', reason: `验收未达标（coverage=${exam.examResult.coverage.toFixed(2)} < 0.95）` };
      }

      /* ⑥ L6 蒸馏门**正式落主内核**（红线 2 不绕门、红线 8 各自 persona）：经同一 DistillationService.ingest。 */
      if (!this.land(personaId, input.candidate)) {
        this.fail(request.id);
        return { ok: false, skipped: false, stage: 'l6_ingest', reason: '蒸馏门落核失败（候选校验/编译被拒）' };
      }

      /* ⑦ learning→passed（CAS）：passed = 本次习得的可审计记录 + GapDetector「已学」来源。 */
      const learnedAt = this.now();
      if (!this.store.transitionStatus(request.id, 'learning', 'passed', learnedAt)) {
        /* 极罕见：learning 被并发改走（cancelled 等）。已落核但账本未标 passed——记 warn 供巡检，
         * 不回滚已落核（落核是合法成长，撤销反而更危险）。 */
        this.logger?.warn(LAYER, `落核后置 passed 失败（learning 被并发改走）: ${request.id}`);
        return { ok: false, skipped: false, stage: 'l6_ingest', reason: '落核成功但账本置 passed 失败（并发）' };
      }

      /* ⑧ 发 capability-learned（红线 20：只标 resolved 不直接执行；不载知识正文）。
       *    学习**已成功提交**（落核 + passed 已落库）——订阅者抛错绝不能翻转结局（否则误报失败 +
       *    外层 catch 调 fail() 对已 passed 无效却混淆诊断，Codex L6 复审）。故 emit 独立 try，
       *    监听器异常只记 warn，编排照常返回成功。 */
      try {
        this.bus.emit('capability-learned', {
          personaId, capability, learningRequestId: request.id, examScore: exam.examResult.coverage,
          learnedAt, tenantId: this.tenantId,
        });
      } catch (emitErr) {
        this.logger?.warn(LAYER, `capability-learned 监听器抛错（不影响已习得）: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`);
      }
      this.logger?.info(LAYER, `★学会★ persona=${personaId} cap=${capability} score=${exam.examResult.coverage.toFixed(2)}`);
      return { ok: true, personaId, capability, examScore: exam.examResult.coverage, learnedAt };
    } catch (err) {
      /* 任一阶段抛异常：保守置 failed（释放幂等槽），不留 learning 悬挂。 */
      this.fail(request.id);
      this.logger?.error(LAYER, `编排异常 req=${request.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, skipped: false, stage: 'l6_ingest', reason: `编排异常: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 经蒸馏门把已 ≥95 验收的候选正式落主内核（红线 2 不绕门）。
   * ingest 满足自动编译门即落核（compiled）；被不确定性预算降级为 pending → 对**已验收**候选显式 approve
   * 强制落核（验收是更强的成长门，不让预算静默丢弃已证明学会的能力）。ingest 真拒（rejected）→ 落核失败。
   */
  private land(personaId: string, candidate: DistilledArtifact): boolean {
    const candidateInput: CandidateInput = {
      kind: candidate.kind, source: candidate.source, payload: candidate.payload,
      confidence: candidate.confidence, evidence: candidate.evidence,
    };
    const res = this.distillation.ingest(personaId, candidateInput);
    if (res.status === 'compiled') return true;
    if (res.status === 'rejected') {
      this.logger?.warn(LAYER, `蒸馏门拒收候选: ${res.reason} [${res.problems.join('; ')}]`);
      return false;
    }
    /* pending：自动编译门未达/预算降级——已 ≥95 验收，显式 approve 强制落核。 */
    const approved = this.distillation.approve(personaId, res.artifact.id);
    if (!approved.ok) {
      this.logger?.warn(LAYER, `蒸馏门 approve 落核失败: ${approved.reason}`);
      return false;
    }
    return true;
  }

  /** 退回：learning→failed（释放 active 幂等槽，红线 9）。CAS 未命中（已被改走）只记不抛。 */
  private fail(requestId: string): void {
    if (!this.store.transitionStatus(requestId, 'learning', 'failed', this.now())) {
      this.logger?.warn(LAYER, `置 failed 未命中（已被并发改走）: ${requestId}`);
    }
  }
}
