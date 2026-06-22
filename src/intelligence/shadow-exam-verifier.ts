/**
 * 影子内核验收器 ShadowExamVerifier（ADR-0057 L4，D0.6）——闭环「学会后运行时零-LLM」论点的关键片。
 *
 * 验收的是「**确定性内核能不能答**」：候选知识临时编译进**影子内核**，用**确定性作答器**
 * （OfflineConversationResponder，零-LLM）按 ExamSpec 作答，确定性 ExamScorer 评分，**无论过不过都回滚**。
 * ≥95 才算「学会」（由调用方 L6 正式落主内核——本验收器**不**碰主内核、不推进学习请求、不发事件）。
 *
 * 副作用完全隔离（红线 18，Codex L4 复审堵的三个口）：
 *   1. **DB 全回滚**：整个影子（编译候选 + 作答读）在 `BEGIN … ROLLBACK` 事务里——**所有** DB 写入
 *      （core 七维 + response_template/rule 专用表 + working_memory）整事务回滚，零持久副作用。
 *   2. **事件不外发**：影子核用**独立隔离 EventBus**（createShadowCore，production listeners 不订阅）——
 *      编译触发的 `core:*` 事件进死信，不外泄。
 *   3. **kind 受限**：只验收**核心人格知识** kind（narrative_patch/value_shift/memory_edge/decision_style_patch/
 *      cognitive_model_patch）——**拒绝** response_template/rule（防御性，纵使事务回滚也不让它们进影子路径）。
 *
 * 其余红线：零-LLM（红线 1/5：作答用确定性内核 + 评分纯函数）；shadow 不绕校验（红线 12：validateArtifact）；
 * compile lease（红线 13）；rubric 不可见作答（红线 16：只喂 question）。
 */

import type { IDatabase } from '../storage/database.js';
import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { Logger } from '../utils/logger.js';
import { ArtifactCompiler } from './artifact-compiler.js';
import type { ResponseTemplateStore } from '../storage/response-template-store.js';
import type { RuleStore } from '../storage/rule-store.js';
import type { Clock } from '../utils/clock.js';
import type { PersonaLeaseStore } from '../storage/persona-lease-store.js';
import { OfflineConversationResponder } from '../conversation/offline-conversation-responder.js';
import { retrieveMemoriesDeterministic } from '../conversation/deterministic-memory-retrieval.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import {
  validateArtifact, scoreExam, failedKeypoints,
  GLOBAL_LEASE_PERSONA_ID,
  type ArtifactKind, type DistilledArtifact, type ExamSpec, type ExamResult,
} from '@chrono/kernel';

/** 影子核工厂：给 personaId 返回一个**隔离 EventBus + 同 db** 的影子 CoreRhythmLayer（不缓存，不污染 os.core）。 */
export type ShadowCoreFactory = (personaId: string) => CoreRhythmLayer;

/** L4 可验收的 artifact kind（核心人格知识；response_template/rule 排除——专用持久表不在影子事务核心路径声明域）。 */
const SHADOW_VERIFIABLE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'narrative_patch', 'value_shift', 'memory_edge', 'decision_style_patch', 'cognitive_model_patch',
]);

/** 影子验收结果。 */
export type ShadowExamResult =
  | { readonly ok: true; readonly passed: boolean; readonly examResult: ExamResult; readonly failedKeypoints: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** 影子编译锁 TTL（与 distillation 同口径，60s）。 */
const SHADOW_COMPILE_LEASE_TTL_MS = 60_000;

export class ShadowExamVerifier {
  private readonly responder = new OfflineConversationResponder();

  constructor(
    private readonly db: IDatabase,
    private readonly shadowCoreFactory: ShadowCoreFactory,
    private readonly now: () => number,
    private readonly logger?: Logger,
    /** 影子核编译 response_template/rule 需要（虽 L4 不验收这两类，编译器构造仍需占位；可缺省）。 */
    private readonly templates?: ResponseTemplateStore,
    private readonly clock?: Clock,
    private readonly rules?: RuleStore,
    /** 影子编译期间持租户级 compile 锁（红线 13）。未注入 = 单进程同步语义（向后兼容）。 */
    private readonly leaseStore?: PersonaLeaseStore,
    /** 作答边界（never_discuss 等，红线 2）；缺省空。 */
    private readonly boundaries: BehaviorBoundary[] = [],
  ) {}

  /**
   * 影子验收：候选编译进影子内核（隔离 bus + 回滚事务）→ 确定性内核作答 → 评分 → **回滚** → 返回是否 ≥95。
   * 纯验收，不碰主内核/不推进学习请求/不发事件（红线 18）。同输入 → 同结果（可复现）。
   */
  verify(personaId: string, examSpec: ExamSpec, candidate: DistilledArtifact): ShadowExamResult {
    /* ① kind 受限（红线 18 防御）：只验收核心人格知识，拒绝 response_template/rule（专用持久表）。 */
    if (!SHADOW_VERIFIABLE_KINDS.has(candidate.kind)) {
      return { ok: false, reason: `kind「${candidate.kind}」不在影子验收范围（核心人格知识 only；response_template/rule 用专用流程）` };
    }

    /* ② shadow 不绕校验（红线 12）：与正式编译同一 validateArtifact。 */
    const problems = validateArtifact(candidate);
    if (problems.length > 0) {
      return { ok: false, reason: `候选工件非法（未过校验）：${problems.join('; ')}` };
    }

    /* ③ compile lease（红线 13）：影子编译期间持租户级 compile 锁，与正式编译/另一影子互斥。 */
    const lease = this.leaseStore?.acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', this.now(), SHADOW_COMPILE_LEASE_TTL_MS);
    if (this.leaseStore && !lease) {
      return { ok: false, reason: 'compile lease 被占（另一编译/影子验收进行中），稍后重试' };
    }

    try {
      /* ④ 影子核：独立隔离 EventBus（core:* 事件不外发，红线 18）。同 db、同 persona。 */
      const shadow = this.shadowCoreFactory(personaId);
      const shadowCompiler = new ArtifactCompiler(() => shadow, this.logger, this.templates, this.clock, this.rules);

      /* ⑤ 全程在**总是回滚**的事务里（db.transactionRollback，跨后端正确绑定 client，比 raw BEGIN 安全，
       *    Codex L4 复审）——所有 DB 写入（core 七维 + 专用表 + working_memory）整事务回滚（红线 5/18）。
       *    无论过不过/抛异常都回滚；fn 内真错误透出由 transactionRollback 回滚后抛。 */
      return this.db.transactionRollback((): ShadowExamResult => {
        const outcome = shadowCompiler.compile(personaId, candidate);
        if (!outcome.ok) {
          return { ok: false, reason: `影子编译失败：${outcome.reason}` };
        }
        /* 确定性内核作答（零-LLM，红线 1/5）：逐题据**编译后**影子核（叙事 + 记忆）作答；rubric 不可见（红线 16）。 */
        const answers: string[] = [];
        for (const q of examSpec.questions) {
          const relevant = retrieveMemoriesDeterministic(
            q.question,
            shadow.memories.getAllMemories(),
            (id) => shadow.memories.getEdgesFor(id),
          );
          const res = this.responder.respond({
            narrative: shadow.narrative.get(),
            boundaries: this.boundaries,
            userInput: q.question,
            relevantKnowledge: relevant,
          });
          answers.push(res.content);
        }
        const examResult = scoreExam(examSpec, answers.join('\n'));
        this.logger?.info('ShadowExamVerifier', `影子验收 cap=${examSpec.capability} coverage=${examResult.coverage.toFixed(2)} passed=${examResult.passed}`);
        return { ok: true, passed: examResult.passed, examResult, failedKeypoints: failedKeypoints(examResult) };
      });
    } catch (err) {
      /* 事务已回滚（transactionRollback 回滚后抛真错误）。lease 仍在 finally 释放（不泄漏，Codex L4 复审）。 */
      return { ok: false, reason: `影子验收异常：${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (lease) this.leaseStore?.release(lease);
    }
  }
}
