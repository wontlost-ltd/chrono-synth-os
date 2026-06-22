/**
 * 双老师互审门·编排单元测试（ADR-0057 L5）。
 *
 * 锁住：两都 approve 才放行；一老师否决退回；blind 初审（各只调一次，互不可见）；前置筛短路（不相关时
 * 不调 LLM）；fail-closed（老师调用/返回非法 → 保守 reject）；独立性前置短路。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeacherReviewGate, type Teacher, type TeacherReviewInput } from '../../intelligence/teacher-review-gate.js';
import type { LLMProvider, TeacherVerdict, TeacherIdentity, DistilledArtifact, JobFunctionContext, ChatMessage } from '@chrono/kernel';

/** 计数调用的桩老师：按预设返回 verdict JSON；记录收到的 prompt（验 blind）。 */
function stubTeacher(verdict: Partial<TeacherVerdict> | string | Error, identity: Partial<TeacherIdentity> = {}): Teacher & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const llm: LLMProvider = {
    async chat(messages) {
      calls.push([...messages]);
      if (verdict instanceof Error) throw verdict;
      const content = typeof verdict === 'string' ? verdict : JSON.stringify({ approve: true, reason: 'ok', productivityRelevance: 'high', conflictsWithExisting: false, ...verdict });
      return { content };
    },
    async embed() { return []; },
  };
  return { llm, identity: { providerId: 'p', modelId: 'm', baseUrl: 'u', apiKeyId: 'k', account: 'a', ...identity }, calls };
}

const ctx: JobFunctionContext = { roleCode: 'researcher_ic', jobFamily: 'ic', requiredCapabilities: ['research'] };
const candidate: DistilledArtifact = {
  id: 'd1', kind: 'narrative_patch', source: 'reflection', payload: { narrative: '学会文献检索' },
  confidence: 0.9, evidence: [{ type: 'test', id: 'e', score: 1 }], status: 'candidate', createdAt: 1000,
} as DistilledArtifact;
const input = (cap = 'research'): TeacherReviewInput => ({ capability: cap, candidate, context: ctx });

describe('TeacherReviewGate（ADR-0057 L5 双老师互审编排）', () => {
  it('★两都 approve + 相关 + 独立 → 放行★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, true);
    assert.equal(r.decision.stage, null);
  });

  it('★一老师否决 → 退回（stage=verdict）★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: false, reason: '偏题' }, { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false);
    assert.equal(r.decision.stage, 'verdict');
    assert.match(r.decision.rejectReason!, /老师B否决.*偏题/);
  });

  it('★blind 初审：每老师各调一次，prompt 不含对方草案★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kB', providerId: 'p2' });
    await new TeacherReviewGate(a, b).review(input());
    assert.equal(a.calls.length, 1, 'A 调一次');
    assert.equal(b.calls.length, 1, 'B 调一次');
    /* A 的 prompt 不含 B 的 identity / 草案（blind）。 */
    const aPrompt = a.calls[0]!.map((m) => m.content).join('');
    assert.ok(!aPrompt.includes('p2') && !aPrompt.includes('kB'), 'A 看不到 B 的身份/草案');
  });

  it('★前置筛短路（红线 7）：能力不相关 → 不调任何 LLM★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input('cooking'));  /* 不在 requiredCapabilities */
    assert.equal(r.decision.approved, false);
    assert.equal(r.decision.stage, 'relevance');
    assert.equal(a.calls.length, 0, '前置不过 → 不调 LLM A');
    assert.equal(b.calls.length, 0, '前置不过 → 不调 LLM B');
  });

  it('★独立性前置短路（红线 6）：伪双老师（同 key）→ 不调 LLM★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kSame' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kSame' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false);
    assert.equal(r.decision.stage, 'independence');
    assert.equal(a.calls.length, 0, '独立性不过 → 不调 LLM');
  });

  it('★fail-closed：老师调用抛错 → 保守 reject★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    const b = stubTeacher(new Error('endpoint 502'), { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false, '一老师失败 → 不放行（fail-closed）');
    assert.equal(r.verdictB.approve, false);
  });

  it('★fail-closed：老师返回非法 JSON（无 approve）→ 保守 reject★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    const b = stubTeacher('{"garbage": true}', { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false);
    assert.equal(r.verdictB.approve, false);
    assert.match(r.verdictB.reason, /非法 verdict/);
  });

  it('★一老师判冲突 → 退回★', async () => {
    const a = stubTeacher({ approve: true, conflictsWithExisting: true }, { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false);
    assert.match(r.decision.rejectReason!, /矛盾/);
  });

  it('★fail-closed：approve=true 但缺 conflictsWithExisting 布尔 → reject（Codex L5 复审）★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA' });
    /* 老师 B 只给 approve，没给 conflictsWithExisting → 不能当「不冲突」放行。 */
    const b = stubTeacher('{"approve":true,"reason":"ok"}', { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false, '缺 conflictsWithExisting 布尔 → 保守 reject');
    assert.equal(r.verdictB.approve, false);
    assert.match(r.verdictB.reason, /非法 verdict/);
  });

  it('★blind 双向：B 的 prompt 也不含 A 身份/草案（Codex L5 复审）★', async () => {
    const a = stubTeacher({ approve: true }, { apiKeyId: 'kA', providerId: 'pA' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kB', providerId: 'pB' });
    await new TeacherReviewGate(a, b).review(input());
    const bPrompt = b.calls[0]!.map((m) => m.content).join('');
    assert.ok(!bPrompt.includes('pA') && !bPrompt.includes('kA'), 'B 看不到 A 的身份/草案');
  });

  it('★弱独立放行（同 provider 不同 key）：本门不拒，留治理（Codex L5 复审）★', async () => {
    const a = stubTeacher({ approve: true }, { providerId: 'openai', account: 'accA', apiKeyId: 'kA', modelId: 'gpt' });
    const b = stubTeacher({ approve: true }, { providerId: 'openai', account: 'accB', apiKeyId: 'kB', modelId: 'gpt' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, true, '同 provider 不同 account/key = 弱独立，本门放行');
  });

  it('★productivityRelevance 非枚举值归一为 unknown（审计字段不污染）★', async () => {
    const a = stubTeacher('{"approve":true,"reason":"ok","productivityRelevance":"超高","conflictsWithExisting":false}', { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: true }, { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.verdictA.productivityRelevance, 'unknown', '非枚举档归一 unknown');
    assert.equal(r.decision.approved, true, '非枚举不影响放行（非门条件）');
  });

  it('★两老师都 reject → 退回（rejectReason 稳定取 A）★', async () => {
    const a = stubTeacher({ approve: false, reason: 'A 拒' }, { apiKeyId: 'kA' });
    const b = stubTeacher({ approve: false, reason: 'B 拒' }, { apiKeyId: 'kB', providerId: 'p2' });
    const r = await new TeacherReviewGate(a, b).review(input());
    assert.equal(r.decision.approved, false);
    assert.match(r.decision.rejectReason!, /老师A否决.*A 拒/, '稳定先报 A');
  });
});
