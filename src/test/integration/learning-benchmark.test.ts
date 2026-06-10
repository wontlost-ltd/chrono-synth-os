/**
 * Persona learning benchmark（WP-2）：用确定性零-LLM 决策引擎 + 固定 oracle，证明「学习后决策更对」可度量。
 *
 * 核心证据（Codex WP-2 Major）：用**固定外部 oracle**（每个 case 的 expectedAlternative）度量命中率
 * accuracy，跨 baseline/learned 可比——它度量「决策对不对」，而非「persona 更偏好它学到的」。
 * 场景：oracle = 探索答案；baseline（稳定占优）答错；learned（探索占优）答对 → accuracy 0→1。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { InMemoryEmbeddingIndex } from '../../intelligence/embedding-index-memory.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { runBenchmark, compareBenchmarks, type BenchmarkCase } from '../../intelligence/learning-benchmark.js';

/** 回放集：每个 case 两备选分别匹配「探索」「稳定」价值；oracle = 探索备选（ground-truth）。 */
const CASES: BenchmarkCase[] = [
  { decisionCase: { id: 'bm_1', title: '机会', description: '面对一个选择', alternatives: ['探索 新方向', '稳定 守现状'] }, expectedAlternative: '探索 新方向' },
  { decisionCase: { id: 'bm_2', title: '资源', description: '资源投向', alternatives: ['探索 未知领域', '稳定 已知收益'] }, expectedAlternative: '探索 未知领域' },
  { decisionCase: { id: 'bm_3', title: '成长', description: '成长路径', alternatives: ['探索 陌生技能', '稳定 精进现有'] }, expectedAlternative: '探索 陌生技能' },
];

describe('persona learning benchmark（WP-2）', () => {
  let os: ChronoSynthOS;

  function buildEngine(): DecisionEngine {
    const router = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const idx = new InMemoryEmbeddingIndex(os.getDatabase(), os.getClock(), router, 'mock-embed');
    return new DecisionEngine(
      os.core,
      new RetrievalService(os.core.memories, idx),
      router, os.getClock(), new SilentLogger(),
      { rollouts: 1, maxOptions: 3 },
      new RuleEngine(os.getClock(), undefined, new SilentLogger()),
    );
  }

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  it('benchmark 可重复（同状态同输入 → 同 accuracy + 同推荐/分）', async () => {
    os.core.addValue('探索', 0.5);
    os.core.addValue('稳定', 0.5);
    const engine = buildEngine();
    const a = await runBenchmark(engine, CASES);
    const b = await runBenchmark(engine, CASES);
    assert.equal(a.accuracy, b.accuracy, '确定性：accuracy 一致');
    assert.deepEqual(a.cases.map((c) => [c.recommended, c.topScore]), b.cases.map((c) => [c.recommended, c.topScore]));
  });

  it('学习（权重移向探索）后 → accuracy 上升（决策更靠近 ground-truth oracle）', async () => {
    /* baseline：稳定占优 → 推荐偏「稳定」备选 → 对 oracle（探索）答错 → 低 accuracy。 */
    const explore = os.core.addValue('探索', 0.2);
    const stable = os.core.addValue('稳定', 0.8);
    const engine = buildEngine();
    const baseline = await runBenchmark(engine, CASES);

    /* 学习：强化探索、弱化稳定（模拟蒸馏后内核倾向变化）。 */
    os.core.updateValueParams(explore.id, { weight: 0.9 });
    os.core.updateValueParams(stable.id, { weight: 0.1 });
    const learned = await runBenchmark(engine, CASES);

    const cmp = compareBenchmarks(baseline, learned);
    /* 核心硬证据：命中率提升（学习让决策更对，不是「persona 更偏好它学到的」）。 */
    assert.ok(cmp.accuracyDelta > 0, `学习应提升命中率：baseline=${baseline.accuracy} learned=${learned.accuracy}`);
    assert.ok(learned.accuracy > baseline.accuracy);
    /* learned 应全部命中 oracle（探索权重高 → 全推探索备选）。 */
    assert.equal(learned.accuracy, 1, '学习后应全部答对 oracle');
    assert.ok(cmp.recommendationChanges >= 1, '学习改变了推荐');
  });

  it('空 case 集 → 抛错（避免「成功但无证据」）', async () => {
    os.core.addValue('探索', 0.5);
    const engine = buildEngine();
    await assert.rejects(() => runBenchmark(engine, []), /must not be empty/);
  });

  it('compareBenchmarks：accuracyDelta + 推荐变化；case 集不一致抛错', () => {
    const mk = (cases: Array<{ caseId: string; recommended: string; correct: boolean }>) => ({
      cases: cases.map((c) => ({ ...c, topScore: 0.5, topRegret: 0.3 })),
      accuracy: cases.filter((c) => c.correct).length / cases.length, meanScore: 0.5, meanRegret: 0.3,
    });
    const baseline = mk([{ caseId: 'c1', recommended: 'A', correct: false }, { caseId: 'c2', recommended: 'B', correct: true }]);
    const learned = mk([{ caseId: 'c1', recommended: 'A2', correct: true }, { caseId: 'c2', recommended: 'B', correct: true }]);
    const cmp = compareBenchmarks(baseline, learned);
    assert.ok(Math.abs(cmp.accuracyDelta - 0.5) < 1e-9, 'accuracy 从 0.5 → 1.0');
    assert.equal(cmp.recommendationChanges, 1, 'c1 推荐变化');
    /* case 集不一致 → 抛错（Codex WP-2 Major）。 */
    const extra = mk([{ caseId: 'c1', recommended: 'A', correct: true }, { caseId: 'c3', recommended: 'X', correct: true }]);
    assert.throws(() => compareBenchmarks(baseline, extra), /case sets differ/);
  });
});

