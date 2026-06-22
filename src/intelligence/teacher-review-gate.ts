/**
 * 双老师互审门·编排（ADR-0057 L5，D0.3）——两个**独立** LLM 老师各自审「该不该学这块知识」，
 * 经**确定性合并门**（kernel mergeTeacherReview）放行/退回。门在蒸馏门**之前**，判「该不该学」（教学层质量）。
 *
 * 确定性纪律（红线 6/7）：门的**判定逻辑全确定性**（前置筛 + 合并 + 独立性在 kernel 纯函数）；只有老师的
 * approve/reject **意见**是 LLM。两都 approve 且都判职能相关才放行（AND）。
 *
 * 独立性（红线 6）：两老师**初审 blind**——各自只看候选 + 职能上下文，**看不到对方草案**（防趋同/串通）；
 * identity tuple 不冲突（kernel 校验）。
 *
 * 范围（L5 本片 = blind 初审 + AND 合并；ADR D0.3「verdict 固化后交叉审对方草案」第二轮**留 L5b**）：
 * 本片实现了独立 blind 初审 + 两都 approve 才放行——已达成独立性 + 一致同意的核心保证。「交叉审对方草案」
 * （verdict 固化后让每位老师再审对方教学内容）是额外鲁棒层，留后续切片（不静默丢，登记在 ADR L5/L5b）。
 *
 * 安全降级（fail-closed）：老师调用/解析失败 → 视为该老师 **reject**（无法确认「该学」就不学，红线侧重保守）。
 */

import type { Logger } from '../utils/logger.js';
import {
  mergeTeacherReview, isJobFunctionRelevant, teacherIndependenceConflict, safeParseJson,
  type LLMProvider, type DistilledArtifact,
  type TeacherVerdict, type TeacherIdentity, type JobFunctionContext, type TeacherReviewDecision,
} from '@chrono/kernel';

/** 一个老师 = LLM provider + 可审计身份。 */
export interface Teacher {
  readonly llm: LLMProvider;
  readonly identity: TeacherIdentity;
}

/** 互审输入。 */
export interface TeacherReviewInput {
  /** 候选学的能力（用于职能相关性前置筛）。 */
  readonly capability: string;
  /** 候选知识工件（老师据此审「该不该学」）。 */
  readonly candidate: DistilledArtifact;
  /** 职能上下文（确定性前置筛）。 */
  readonly context: JobFunctionContext;
}

/** 互审结果：确定性合并决策 + 两老师 verdict（审计，对齐 L2 账本）。 */
export interface TeacherReviewResult {
  readonly decision: TeacherReviewDecision;
  readonly verdictA: TeacherVerdict;
  readonly verdictB: TeacherVerdict;
}

/** 老师调用/解析失败时的保守 verdict（fail-closed：不批准 + 标因）。 */
function failedVerdict(reason: string): TeacherVerdict {
  return { approve: false, reason, productivityRelevance: 'unknown', conflictsWithExisting: false };
}

export class TeacherReviewGate {
  constructor(
    private readonly teacherA: Teacher,
    private readonly teacherB: Teacher,
    private readonly logger?: Logger,
  ) {}

  /**
   * 双老师互审：初审 blind（各自只看候选 + 上下文，互不可见对方）→ 解析 verdict → 确定性合并门。
   * 放行（decision.approved）才进蒸馏（L6）；退回则记 verdict + 阶段（审计）。
   */
  async review(input: TeacherReviewInput): Promise<TeacherReviewResult> {
    /* ① 确定性前置短路（红线 7：相关性前置筛在 LLM **之前**，省 LLM 成本；红线 6：独立性也前置）——
     *   前置不过则**不调任何 LLM 老师**（伪 verdict 标因，审计）。 */
    const indep = teacherIndependenceConflict(this.teacherA.identity, this.teacherB.identity);
    if (indep) {
      const v = failedVerdict('未审核（独立性前置不过）');
      return { decision: { approved: false, rejectReason: indep, stage: 'independence' }, verdictA: v, verdictB: v };
    }
    if (!isJobFunctionRelevant(input.capability, input.context)) {
      const v = failedVerdict('未审核（职能相关性前置不过）');
      const decision = mergeTeacherReview(input.capability, input.context,
        { verdict: v, identity: this.teacherA.identity }, { verdict: v, identity: this.teacherB.identity });
      this.logger?.info('TeacherReviewGate', `互审 cap=${input.capability} 前置筛未过（未调 LLM）`);
      return { decision, verdictA: v, verdictB: v };
    }

    /* ② 两老师**并行 blind 初审**（互不可见对方草案，红线 6）。 */
    const [verdictA, verdictB] = await Promise.all([
      this.askTeacher(this.teacherA, input, 'A'),
      this.askTeacher(this.teacherB, input, 'B'),
    ]);

    /* ③ 确定性合并门（kernel 纯函数：再跑前置筛 + 独立性 + AND，幂等）。 */
    const decision = mergeTeacherReview(
      input.capability, input.context,
      { verdict: verdictA, identity: this.teacherA.identity },
      { verdict: verdictB, identity: this.teacherB.identity },
    );
    this.logger?.info('TeacherReviewGate', `互审 cap=${input.capability} approved=${decision.approved} stage=${decision.stage ?? 'pass'}`);
    return { decision, verdictA, verdictB };
  }

  /** 单老师 blind 初审：喂候选 + 职能上下文（不含对方草案），返回 verdict。失败 → 保守 reject。 */
  private async askTeacher(teacher: Teacher, input: TeacherReviewInput, label: string): Promise<TeacherVerdict> {
    const system = [
      'TASK:TEACHER_REVIEW',
      '你是一名严格的导师，独立审核「这个数字员工该不该学这块知识」。判据：',
      '1) 与其职能（role/family/required capabilities）相关；2) 能落到可执行能力、能提高生产力；',
      '3) 与其已有知识不矛盾。偏题/无关/矛盾的一律不批准。',
      '只输出 JSON：{"approve":true|false,"reason":"...","productivityRelevance":"high|medium|low|unknown","conflictsWithExisting":true|false}',
    ].join('\n');
    const user = [
      `候选能力: ${input.capability}`,
      `职能上下文: role=${input.context.roleCode}, family=${input.context.jobFamily}, required=[${input.context.requiredCapabilities.join(', ')}]`,
      `候选知识工件: kind=${input.candidate.kind}, payload=${JSON.stringify(input.candidate.payload)}`,
    ].join('\n');

    try {
      const res = await teacher.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseJson<Partial<TeacherVerdict>>(res.content);
      /* fail-closed（Codex L5 复审）：approve **和** conflictsWithExisting 都是放行门条件，二者**都必须**是合法
       * 布尔——缺失/非布尔说明老师没给出有效判断，**保守 reject**（不能把「没说」当「不冲突」放行）。 */
      if (!parsed || typeof parsed.approve !== 'boolean' || typeof parsed.conflictsWithExisting !== 'boolean') {
        return failedVerdict(`老师${label}返回非法 verdict（approve/conflictsWithExisting 须为布尔）`);
      }
      /* productivityRelevance 仅审计（非放行条件）：非枚举值归一为 unknown。 */
      const rel = parsed.productivityRelevance;
      const productivityRelevance: TeacherVerdict['productivityRelevance'] =
        rel === 'high' || rel === 'medium' || rel === 'low' ? rel : 'unknown';
      return {
        approve: parsed.approve,
        reason: typeof parsed.reason === 'string' && parsed.reason.length > 0 ? parsed.reason : '（无理由）',
        productivityRelevance,
        conflictsWithExisting: parsed.conflictsWithExisting,
      };
    } catch (err) {
      this.logger?.warn('TeacherReviewGate', `老师${label}调用失败（保守 reject）: ${err instanceof Error ? err.message : String(err)}`);
      return failedVerdict(`老师${label}调用失败`);
    }
  }
}
