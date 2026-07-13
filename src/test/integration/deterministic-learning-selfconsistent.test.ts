/**
 * 确定性进修生成器**自洽性**验证（进修闭环零-LLM 底座的地基测试）。
 *
 * 核心不变量：generateDeterministicLearning 产的 (candidate, examSpec) 必须自洽——
 *  ① examSpec 过 lintExamSpec（否则 ShadowExamVerifier fail-closed 拒验收）；
 *  ② candidate 学进影子内核后，确定性内核作答能通过该 examSpec（≥95）——「学什么考什么，学到就答得出」；
 *  ③ 确定性可复现（同输入同产出）；④ examSpec.capability 逐字等于输入 capability（orchestrate 硬校验）。
 * 若这条自洽链断，整个确定性进修闭环就是死的——所以这是地基测试。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { ShadowExamVerifier } from '../../intelligence/shadow-exam-verifier.js';
import { generateDeterministicLearning, lintExamSpec } from '@chrono/kernel';

describe('确定性进修生成器自洽性（零-LLM 闭环地基）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;
  let verifier: ShadowExamVerifier;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    verifier = new ShadowExamVerifier(
      os.getDatabase(), (pid) => os.createShadowCore(pid), () => clock.now(), new SilentLogger(),
    );
  });
  afterEach(() => os.close());

  it('生成的 examSpec 过 lintExamSpec（否则验收 fail-closed）', () => {
    const { examSpec } = generateDeterministicLearning({
      learningRequestId: 'lr1', capability: 'data_analysis',
      evidence: '数据清洗，统计建模，可视化报告', now: 1000,
    });
    const lint = lintExamSpec(examSpec);
    assert.equal(lint.ok, true, `lint 失败：${lint.ok ? '' : JSON.stringify(lint.violations)}`);
  });

  it('★自洽核心★：candidate 学进影子内核 → 确定性作答通过自产 exam（≥95）', () => {
    const { candidate, examSpec } = generateDeterministicLearning({
      learningRequestId: 'lr2', capability: 'research',
      evidence: '文献检索，综合归纳，引用来源', now: 1000,
    });
    const r = verifier.verify('p-learner', examSpec, candidate);
    assert.equal(r.ok, true, `验收出错：${r.ok ? '' : r.reason}`);
    if (!r.ok) return;
    assert.equal(r.passed, true, '学到自产叙事 → 作答覆盖全部要点 → ≥95 通过');
    assert.ok(r.examResult.coverage >= 0.95, `coverage=${r.examResult.coverage}`);
  });

  it('evidence 为空也能生成合法自洽考卷（capability 派生占位要点补齐 ≥2）', () => {
    const { candidate, examSpec } = generateDeterministicLearning({
      learningRequestId: 'lr3', capability: 'support_ticket', evidence: '', now: 1000,
    });
    assert.equal(lintExamSpec(examSpec).ok, true, '空 evidence 仍过 lint');
    const r = verifier.verify('p-learner2', examSpec, candidate);
    assert.equal(r.ok && r.passed, true, '空 evidence 也自洽通过');
  });

  it('capability 逐字等于输入（orchestrate 硬校验前提）', () => {
    const { examSpec } = generateDeterministicLearning({
      learningRequestId: 'lr4', capability: 'content_piece', evidence: 'x', now: 1000,
    });
    assert.equal(examSpec.capability, 'content_piece');
  });

  it('确定性可复现：同输入 → 同 candidate + 同 examSpec', () => {
    const input = { learningRequestId: 'lr5', capability: 'research', evidence: '检索，归纳', now: 1000 };
    const a = generateDeterministicLearning(input);
    const b = generateDeterministicLearning(input);
    assert.deepEqual(a, b, '纯函数确定性');
  });
});
