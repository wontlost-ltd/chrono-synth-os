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
 * 两阶段（L5 + L5b）：① blind 初审（各只看候选 + 上下文，互不可见对方，红线 6）+ 确定性 AND 合并；
 * ② **L5b 交叉审第二轮**（opt-in，crossReview=true 启用）——初审 verdict 固化后让每位老师看**对方草案**
 * 再复核（catch 伪共识/理由相悖），kernel mergeCrossReview **只收紧不放松**（任一不 endorse → 退回；初审
 * 已退回则不跑、不翻盘）。第二轮看对方是**设计本意**（非破坏第一轮 blind——blind 只约束初审）。
 *
 * 安全降级（fail-closed）：老师调用/解析失败 → 视为该老师 **reject**（无法确认「该学」就不学，红线侧重保守）。
 */

import type { Logger } from '../utils/logger.js';
import {
  mergeTeacherReview, mergeCrossReview, isJobFunctionRelevant, teacherIndependenceConflict, safeParseJson,
  type LLMProvider, type DistilledArtifact,
  type TeacherVerdict, type TeacherIdentity, type JobFunctionContext, type TeacherReviewDecision,
  type CrossReviewVerdict,
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
  /** L5b 交叉审第二轮结果（仅 crossReview 启用且初审放行时有；审计）。 */
  readonly crossA?: CrossReviewVerdict;
  readonly crossB?: CrossReviewVerdict;
}

/** 老师调用/解析失败时的保守 verdict（fail-closed：不批准 + 标因）。 */
function failedVerdict(reason: string): TeacherVerdict {
  return { approve: false, reason, productivityRelevance: 'unknown', conflictsWithExisting: false };
}

/** 交叉审失败时的保守复核（fail-closed：不 endorse + 标因）。 */
function failedCrossReview(reason: string): CrossReviewVerdict {
  return { endorse: false, reason };
}

export class TeacherReviewGate {
  constructor(
    private readonly teacherA: Teacher,
    private readonly teacherB: Teacher,
    private readonly logger?: Logger,
    /**
     * L5b：是否启用交叉审第二轮（opt-in，默认 false=纯 L5 行为向后兼容）。启用后初审放行的候选再让每位老师
     * 看对方草案复核——**只收紧不放松**（catch 伪共识）。额外 LLM 成本，由调用方按鲁棒性需求开启。
     */
    private readonly crossReview = false,
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
    const roundOne = mergeTeacherReview(
      input.capability, input.context,
      { verdict: verdictA, identity: this.teacherA.identity },
      { verdict: verdictB, identity: this.teacherB.identity },
    );

    /* ④ L5b 交叉审第二轮（opt-in）：仅当初审放行才跑（退回则无需再审，省 LLM）。每位老师看**对方草案**复核，
     *   kernel mergeCrossReview **只收紧不放松**（任一不 endorse → 退回 cross_review）。未启用 → 沿用初审。 */
    if (this.crossReview && roundOne.approved) {
      const [crossA, crossB] = await Promise.all([
        this.askCrossReview(this.teacherA, input, verdictA, verdictB, 'A'),
        this.askCrossReview(this.teacherB, input, verdictB, verdictA, 'B'),
      ]);
      const decision = mergeCrossReview(roundOne, crossA, crossB);
      this.logger?.info('TeacherReviewGate', `互审+交叉审 cap=${input.capability} approved=${decision.approved} stage=${decision.stage ?? 'pass'}`);
      return { decision, verdictA, verdictB, crossA, crossB };
    }

    this.logger?.info('TeacherReviewGate', `互审 cap=${input.capability} approved=${roundOne.approved} stage=${roundOne.stage ?? 'pass'}`);
    return { decision: roundOne, verdictA, verdictB };
  }

  /**
   * 单老师交叉审第二轮（L5b）：固化双方初审后，喂该老师**自己的初审 + 对方草案**，问看了对方后是否仍 endorse。
   * 只收紧（发现分歧/疑虑 → endorse=false）。失败/非法 → 保守不 endorse（fail-closed）。
   */
  private async askCrossReview(
    teacher: Teacher, input: TeacherReviewInput, ownVerdict: TeacherVerdict, peerVerdict: TeacherVerdict, label: string,
  ): Promise<CrossReviewVerdict> {
    const system = [
      'TASK:TEACHER_CROSS_REVIEW',
      '你已对「这个数字员工该不该学这块知识」给过初审意见。现在给你看**另一位独立导师**的初审草案。',
      '请复核：看了对方的判断后，你是否仍坚持放行？若发现对方指出了你忽略的问题、或你们看似一致但理由相悖/',
      '实为伪共识，则**不再 endorse**（宁可保守退回再议）。只输出 JSON：{"endorse":true|false,"reason":"..."}',
    ].join('\n');
    const user = [
      `候选能力: ${input.capability}`,
      `职能上下文: role=${input.context.roleCode}, family=${input.context.jobFamily}, required=[${input.context.requiredCapabilities.join(', ')}]`,
      `候选知识工件: kind=${input.candidate.kind}, payload=${JSON.stringify(input.candidate.payload)}`,
      `你的初审: approve=${ownVerdict.approve}, 理由=${ownVerdict.reason}, 相关性=${ownVerdict.productivityRelevance}, 冲突=${ownVerdict.conflictsWithExisting}`,
      `对方导师初审草案: approve=${peerVerdict.approve}, 理由=${peerVerdict.reason}, 相关性=${peerVerdict.productivityRelevance}, 冲突=${peerVerdict.conflictsWithExisting}`,
    ].join('\n');

    try {
      const res = await teacher.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseJson<Partial<CrossReviewVerdict>>(res.content);
      /* fail-closed：endorse 非布尔 → 不 endorse（不能把「没说」当「认可」放行）。 */
      if (!parsed || typeof parsed.endorse !== 'boolean') {
        return failedCrossReview(`老师${label}交叉审返回非法（endorse 须为布尔）`);
      }
      return {
        endorse: parsed.endorse,
        reason: typeof parsed.reason === 'string' && parsed.reason.length > 0 ? parsed.reason : '（无理由）',
      };
    } catch (err) {
      this.logger?.warn('TeacherReviewGate', `老师${label}交叉审调用失败（保守不 endorse）: ${err instanceof Error ? err.message : String(err)}`);
      return failedCrossReview(`老师${label}交叉审调用失败`);
    }
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
