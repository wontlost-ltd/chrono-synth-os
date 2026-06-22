/**
 * 双老师互审门·纯逻辑（ADR-0057 L5，D0.3）——确定性部分：职能相关性前置筛 + verdict 合并 + 老师独立性校验。
 *
 * L5 分两层：**LLM 部分**（两个独立老师各自产出 approve/reject 意见，在 src/intelligence 编排）+ **确定性部分**
 * （本模块）。门的**判定逻辑**必须确定性（红线 6/7）——只有老师的 APPROVE/REJECT 意见是 LLM，其余全确定性：
 *   1. **职能相关性前置筛**（在 LLM 之前）：候选能力必须命中 persona 的 **requiredCapabilities**（确定性硬绑定来源），
 *      过不了直接退回（减少纯 LLM 主观，红线 7）。**roleCode/jobFamily 是审计上下文**，不参与确定性映射——
 *      硬绑定只认 requiredCapabilities（与 L1 `required − learned` 纯集合差同纪律；role→capability 词表若需另起
 *      registry，留后续，避免在 L5 凭空发明语义映射，Codex L5 复审确认此口径）。
 *   2. **verdict 合并**：两都 approve 且都判职能相关才放行（AND，红线 6）；任一否决/弃权 → 退回。
 *   3. **独立性校验**：两老师的 independence tuple 不得冲突（至少禁同 provider+account+key，红线 6）。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。LLM 调用/解析在宿主层（src/intelligence/teacher-review-gate）。
 */

import { normalizeCapability } from '../capability/capability-taxonomy.js';

/** 老师对候选知识的判定（LLM 产出，本模块只做确定性合并；relevance 是老师的主观判断）。 */
export interface TeacherVerdict {
  /** 该不该学这块（核心意见）。 */
  readonly approve: boolean;
  /** 理由（审计；非空）。 */
  readonly reason: string;
  /** 生产力相关性（老师主观档；merge 不强制用，仅审计 + 可选阈值）。 */
  readonly productivityRelevance: 'high' | 'medium' | 'low' | 'unknown';
  /** 是否与该 persona 已有知识矛盾（老师判断；true → 退回，红线：与已有知识不矛盾）。 */
  readonly conflictsWithExisting: boolean;
}

/** 老师的可审计身份元组（独立性校验用，红线 6）。 */
export interface TeacherIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKeyId: string;
  readonly account: string;
}

/** 职能上下文（确定性前置筛输入；来自 persona 的岗位 + 任务）。 */
export interface JobFunctionContext {
  readonly roleCode: string;
  readonly jobFamily: string;
  /** persona 岗位/任务声明的所需能力（确定性相关性的硬来源）。 */
  readonly requiredCapabilities: readonly string[];
}

/** 合并结果（确定性）。 */
export interface TeacherReviewDecision {
  /** 是否放行进学习（两都 approve + 都不冲突 + 前置筛过 + 独立性 OK）。 */
  readonly approved: boolean;
  /** 退回原因（approved=false 时非空；可审计）。 */
  readonly rejectReason: string | null;
  /** 退回阶段：relevance（前置筛）/ independence / verdict（老师否决）/ null（通过）。 */
  readonly stage: 'relevance' | 'independence' | 'verdict' | null;
}

/**
 * 独立性冲突判定（红线 6）：两老师**至少**不得同 provider + 同 account + 同 key（伪双老师）。
 * 返回冲突原因（null = 独立）。同 provider 不同 account/key = 弱独立（不在此拒，由治理层提审计要求）。
 */
export function teacherIndependenceConflict(a: TeacherIdentity, b: TeacherIdentity): string | null {
  if (a.apiKeyId === b.apiKeyId) return '两老师同 apiKeyId（同一把 key 冒充双老师）';
  if (a.providerId === b.providerId && a.account === b.account && a.modelId === b.modelId) {
    return '两老师同 provider+account+model（实质同一老师）';
  }
  return null;
}

/**
 * 职能相关性前置筛（确定性，在 LLM 之前）：候选能力是否映射到 persona 的 requiredCapabilities。
 * 规范化后比对——命中 requiredCapabilities 即相关。**不**做 LLM/语义判断（红线 1/7：减少纯主观）。
 * requiredCapabilities 为空（无职能声明）→ 视为不通过（不能学无职能依据的偏题）。
 */
export function isJobFunctionRelevant(capability: string, ctx: JobFunctionContext): boolean {
  const cap = normalizeCapability(capability);
  if (cap.length === 0) return false;
  const required = new Set(ctx.requiredCapabilities.map(normalizeCapability));
  return required.has(cap);
}

/**
 * 合并双老师 verdict + 前置筛 + 独立性（确定性门，红线 6/7）。任一不过 → 退回并标阶段。
 * 放行条件：① independence OK ② 职能相关性前置筛过 ③ 两都 approve ④ 两都判不冲突。
 */
export function mergeTeacherReview(
  capability: string,
  ctx: JobFunctionContext,
  teacherA: { verdict: TeacherVerdict; identity: TeacherIdentity },
  teacherB: { verdict: TeacherVerdict; identity: TeacherIdentity },
): TeacherReviewDecision {
  /* ① 独立性（红线 6）：伪双老师直接退回。 */
  const indep = teacherIndependenceConflict(teacherA.identity, teacherB.identity);
  if (indep) {
    return { approved: false, rejectReason: indep, stage: 'independence' };
  }

  /* ② 职能相关性前置筛（确定性，LLM 之前；红线 7）。 */
  if (!isJobFunctionRelevant(capability, ctx)) {
    return {
      approved: false,
      rejectReason: `能力「${capability}」与该 persona 职能（role=${ctx.roleCode}/family=${ctx.jobFamily}/required=[${ctx.requiredCapabilities.join(',')}]）不相关（前置筛未过）`,
      stage: 'relevance',
    };
  }

  /* ③④ 两老师都 approve 且都判不冲突（AND，红线 6）。 */
  if (!teacherA.verdict.approve || !teacherB.verdict.approve) {
    const who = !teacherA.verdict.approve ? 'A' : 'B';
    const reason = !teacherA.verdict.approve ? teacherA.verdict.reason : teacherB.verdict.reason;
    return { approved: false, rejectReason: `老师${who}否决：${reason}`, stage: 'verdict' };
  }
  if (teacherA.verdict.conflictsWithExisting || teacherB.verdict.conflictsWithExisting) {
    const who = teacherA.verdict.conflictsWithExisting ? 'A' : 'B';
    return { approved: false, rejectReason: `老师${who}判定与已有知识矛盾`, stage: 'verdict' };
  }

  return { approved: true, rejectReason: null, stage: null };
}
