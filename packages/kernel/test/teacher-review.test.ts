/**
 * 双老师互审门·纯逻辑单元测试（ADR-0057 L5）。
 *
 * 锁住确定性门：职能相关性前置筛（绑 requiredCapabilities）；独立性校验（伪双老师拒）；
 * verdict 合并（两都 approve 才放行，任一否决/冲突退回 + 标阶段）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTeacherReview, mergeCrossReview, isJobFunctionRelevant, teacherIndependenceConflict,
  type TeacherVerdict, type TeacherIdentity, type JobFunctionContext, type TeacherReviewDecision,
} from '../src/domain/exam/index.js';

const ctx: JobFunctionContext = { roleCode: 'researcher_ic', jobFamily: 'ic', requiredCapabilities: ['research', 'analysis'] };

function verdict(over: Partial<TeacherVerdict> = {}): TeacherVerdict {
  return { approve: true, reason: 'ok', productivityRelevance: 'high', conflictsWithExisting: false, ...over };
}
function identity(over: Partial<TeacherIdentity> = {}): TeacherIdentity {
  return { providerId: 'openai', modelId: 'gpt', baseUrl: 'https://a', apiKeyId: 'k1', account: 'acc1', ...over };
}
const teacherA = (v: Partial<TeacherVerdict> = {}, id: Partial<TeacherIdentity> = {}) => ({ verdict: verdict(v), identity: identity({ apiKeyId: 'kA', account: 'accA', ...id }) });
const teacherB = (v: Partial<TeacherVerdict> = {}, id: Partial<TeacherIdentity> = {}) => ({ verdict: verdict(v), identity: identity({ providerId: 'anthropic', apiKeyId: 'kB', account: 'accB', ...id }) });

describe('isJobFunctionRelevant（职能相关性前置筛）', () => {
  it('★命中 requiredCapabilities → 相关★', () => {
    assert.equal(isJobFunctionRelevant('research', ctx), true);
    assert.equal(isJobFunctionRelevant('Research', ctx), true, '规范化后命中');
  });
  it('★不在 requiredCapabilities → 不相关★', () => {
    assert.equal(isJobFunctionRelevant('cooking', ctx), false);
  });
  it('★空能力/空 required → 不相关（不能学无职能依据）★', () => {
    assert.equal(isJobFunctionRelevant('', ctx), false);
    assert.equal(isJobFunctionRelevant('research', { ...ctx, requiredCapabilities: [] }), false);
  });
});

describe('teacherIndependenceConflict（独立性校验，红线 6）', () => {
  it('★同 apiKeyId → 冲突★', () => {
    assert.match(teacherIndependenceConflict(identity({ apiKeyId: 'k' }), identity({ apiKeyId: 'k' }))!, /apiKeyId/);
  });
  it('★同 provider+account+model → 冲突★', () => {
    const a = identity({ providerId: 'openai', account: 'x', modelId: 'gpt', apiKeyId: 'k1' });
    const b = identity({ providerId: 'openai', account: 'x', modelId: 'gpt', apiKeyId: 'k2' });
    assert.match(teacherIndependenceConflict(a, b)!, /provider\+account\+model/);
  });
  it('★不同 provider → 独立★', () => {
    assert.equal(teacherIndependenceConflict(identity({ providerId: 'openai', apiKeyId: 'k1' }), identity({ providerId: 'anthropic', apiKeyId: 'k2' })), null);
  });
});

describe('mergeTeacherReview（确定性合并门，红线 6/7）', () => {
  it('★两都 approve + 相关 + 独立 → 放行★', () => {
    const r = mergeTeacherReview('research', ctx, teacherA(), teacherB());
    assert.equal(r.approved, true);
    assert.equal(r.stage, null);
  });

  it('★职能不相关 → 前置筛退回（stage=relevance）★：LLM 都没调到', () => {
    const r = mergeTeacherReview('cooking', ctx, teacherA(), teacherB());
    assert.equal(r.approved, false);
    assert.equal(r.stage, 'relevance');
    assert.match(r.rejectReason!, /不相关|前置筛/);
  });

  it('★伪双老师 → 独立性退回（stage=independence）★', () => {
    const same = { apiKeyId: 'kSame', account: 'accSame', providerId: 'openai', modelId: 'gpt' };
    const r = mergeTeacherReview('research', ctx, teacherA({}, same), teacherB({}, same));
    assert.equal(r.approved, false);
    assert.equal(r.stage, 'independence');
  });

  it('★一老师否决 → 退回（stage=verdict）★', () => {
    const r = mergeTeacherReview('research', ctx, teacherA(), teacherB({ approve: false, reason: '偏题无关本职' }));
    assert.equal(r.approved, false);
    assert.equal(r.stage, 'verdict');
    assert.match(r.rejectReason!, /老师B否决.*偏题/);
  });

  it('★一老师判冲突 → 退回（stage=verdict）★', () => {
    const r = mergeTeacherReview('research', ctx, teacherA({ conflictsWithExisting: true }), teacherB());
    assert.equal(r.approved, false);
    assert.equal(r.stage, 'verdict');
    assert.match(r.rejectReason!, /矛盾/);
  });

  it('★门顺序：独立性 > 相关性 > verdict★（伪双老师 + 不相关 → 先报 independence）', () => {
    const same = { apiKeyId: 'k', account: 'a', providerId: 'openai', modelId: 'gpt' };
    const r = mergeTeacherReview('cooking', ctx, teacherA({}, same), teacherB({}, same));
    assert.equal(r.stage, 'independence', '独立性最先判');
  });

  it('★确定性可复现★：同输入 → 同决策', () => {
    const a = mergeTeacherReview('research', ctx, teacherA(), teacherB());
    const b = mergeTeacherReview('research', ctx, teacherA(), teacherB());
    assert.deepEqual(a, b);
  });
});

describe('mergeCrossReview（ADR-0057 L5b 交叉审第二轮，只收紧不放松）', () => {
  const approved: TeacherReviewDecision = { approved: true, rejectReason: null, stage: null };
  const rejected: TeacherReviewDecision = { approved: false, rejectReason: '老师A否决：偏题', stage: 'verdict' };

  it('★初审放行 + 两交叉审都 endorse → 最终放行★', () => {
    const r = mergeCrossReview(approved, { endorse: true, reason: 'ok' }, { endorse: true, reason: 'ok' });
    assert.equal(r.approved, true);
    assert.equal(r.stage, null);
  });

  it('★初审放行 + 一交叉审不 endorse → 退回（stage=cross_review，只收紧）★', () => {
    const r = mergeCrossReview(approved, { endorse: true, reason: 'ok' }, { endorse: false, reason: '看了对方发现伪共识' });
    assert.equal(r.approved, false);
    assert.equal(r.stage, 'cross_review');
    assert.match(r.rejectReason!, /老师B.*伪共识/);
  });

  it('★初审已退回 → 交叉审不可能翻成放行（沿用初审）★', () => {
    /* 即便两交叉审都 endorse，初审退回的结论不变（交叉审只收紧，不能放松）。 */
    const r = mergeCrossReview(rejected, { endorse: true, reason: 'ok' }, { endorse: true, reason: 'ok' });
    assert.deepEqual(r, rejected, '初审退回原样沿用');
  });

  it('★两交叉审都不 endorse → 退回（稳定先报 A）★', () => {
    const r = mergeCrossReview(approved, { endorse: false, reason: 'A 疑虑' }, { endorse: false, reason: 'B 疑虑' });
    assert.equal(r.approved, false);
    assert.match(r.rejectReason!, /老师A.*A 疑虑/, '稳定先报 A');
  });

  it('★确定性可复现★：同输入 → 同决策', () => {
    const a = mergeCrossReview(approved, { endorse: true, reason: 'x' }, { endorse: false, reason: 'y' });
    const b = mergeCrossReview(approved, { endorse: true, reason: 'x' }, { endorse: false, reason: 'y' });
    assert.deepEqual(a, b);
  });
});
