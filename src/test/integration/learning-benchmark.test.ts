/**
 * Persona learning benchmark（WP-2）：用确定性零-LLM 决策引擎，证明「学习后决策更好」可度量。
 *
 * 构造一个「学习应让 X 更好」的场景：persona 起初对某价值权重低 → 决策与该价值对齐度/综合分一般；
 * 经价值蒸馏（强化该价值）后 → 同一组 case 的综合分上升 / 后悔概率下降。benchmark 把这变成数字。
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
import { runBenchmark, compareBenchmarks } from '../../intelligence/learning-benchmark.js';
import type { DecisionCase } from '../../intelligence/types.js';

/** 一组固定 decision case（回放集）：每个 case 的两个备选分别强匹配「探索」与「稳定」两个价值
 * （关键词出现在备选文案里）。这样价值权重的此消彼长会改变加权对齐分（单值时权重会被比值约掉）。 */
const CASES: DecisionCase[] = [
  { id: 'bm_1', title: '机会', description: '面对一个选择', alternatives: ['探索 新方向', '稳定 守现状'] },
  { id: 'bm_2', title: '资源', description: '资源投向', alternatives: ['探索 未知领域', '稳定 已知收益'] },
  { id: 'bm_3', title: '成长', description: '成长路径', alternatives: ['探索 陌生技能', '稳定 精进现有'] },
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

  it('benchmark 可重复（同状态同输入 → 同指标）', async () => {
    os.core.addValue('探索', 0.5);
    os.core.addValue('稳定', 0.5);
    const engine = buildEngine();
    const a = await runBenchmark(engine, CASES);
    const b = await runBenchmark(engine, CASES);
    assert.equal(a.meanScore, b.meanScore, '确定性：重复运行指标一致');
    assert.equal(a.meanRegret, b.meanRegret);
  });

  it('学习（把权重从「稳定」移向「探索」）后 → 推荐倒向探索 + 综合分上升（学习有效性）', async () => {
    /* baseline：稳定价值占优（探索弱）。两值竞争 → 推荐偏「稳定」备选。 */
    const explore = os.core.addValue('探索', 0.2);
    const stable = os.core.addValue('稳定', 0.8);
    const engine = buildEngine();
    const baseline = await runBenchmark(engine, CASES);

    /* 学习：强化「探索」、弱化「稳定」（模拟蒸馏后内核倾向变化）。 */
    os.core.updateValueParams(explore.id, { weight: 0.9 });
    os.core.updateValueParams(stable.id, { weight: 0.1 });
    const learned = await runBenchmark(engine, CASES);

    const cmp = compareBenchmarks(baseline, learned);
    /* 学习改变了决策：探索权重升高后，至少一个 case 推荐倒向「探索」备选。 */
    assert.ok(cmp.recommendationChanges >= 1, `学习应改变推荐，实际变化 ${cmp.recommendationChanges} 个`);
    /* 学习后推荐项（探索）对齐度应不低于基线（探索价值现在权重高 + 高对齐）。 */
    assert.ok(
      cmp.meanScoreDelta >= 0 || cmp.meanRegretDelta <= 0,
      `学习应改善或持平：meanScoreDelta=${cmp.meanScoreDelta.toFixed(4)} meanRegretDelta=${cmp.meanRegretDelta.toFixed(4)}`,
    );
    /* 学习后推荐应倒向「探索」备选（关键词验证学习方向正确）。 */
    assert.ok(
      learned.cases.every((c) => c.recommended.includes('探索')),
      `学习后应推荐探索备选，实际: ${learned.cases.map((c) => c.recommended).join(' | ')}`,
    );
  });

  it('compareBenchmarks 正确计 delta + 推荐变化数', () => {
    const baseline = {
      cases: [
        { caseId: 'c1', recommended: 'A', topScore: 0.5, topRegret: 0.4 },
        { caseId: 'c2', recommended: 'B', topScore: 0.6, topRegret: 0.3 },
      ],
      meanScore: 0.55, meanRegret: 0.35,
    };
    const learned = {
      cases: [
        { caseId: 'c1', recommended: 'A2', topScore: 0.7, topRegret: 0.2 }, // 推荐变了
        { caseId: 'c2', recommended: 'B', topScore: 0.8, topRegret: 0.25 },
      ],
      meanScore: 0.75, meanRegret: 0.225,
    };
    const cmp = compareBenchmarks(baseline, learned);
    assert.ok(Math.abs(cmp.meanScoreDelta - 0.2) < 1e-9, '综合分提升 0.2');
    assert.ok(Math.abs(cmp.meanRegretDelta - -0.125) < 1e-9, '后悔下降 0.125');
    assert.equal(cmp.recommendationChanges, 1, 'c1 推荐变化');
  });
});
