/**
 * Persona learning benchmark（WP-2）：用确定性零-LLM 决策引擎 + 固定 oracle 度量决策命中率。
 *
 * 主指标 accuracy（命中固定外部 oracle expectedAlternative 的比例）跨 baseline/learned 可比——
 * 它度量「决策对不对」而非「persona 更偏好它学到的」（Codex WP-2 Major）。
 *
 * 两层证据（强度不同，命名上严格区分，避免把弱测试包装成强结论 · Codex WP-2 复审）：
 *   1. 真实闭环（强）：经 earn→distill→门控→编译 真正改写 core value 权重后 accuracy 上升。
 *      这才是「自我进化使决策更优」的证据。
 *   2. 手动调权（弱）：直接 updateValueParams 翻转权重 → 只证明「权重变化会改变 RuleEngine 排序」，
 *      是 benchmark 框架的灵敏度自检，不代表真实学习。
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
import { runBenchmark, compareBenchmarks, type BenchmarkCase, type BenchmarkMetrics } from '../../intelligence/learning-benchmark.js';

/** 回放集：每个 case 两备选分别匹配「探索」「稳定」价值；oracle = 探索备选（固定 ground-truth）。 */
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

  /**
   * 强证据：真实自我进化闭环。不手调权重——通过 earn→distill→门控→编译 让内核**自己**改写
   * 「探索」价值权重，再回放同一 benchmark，accuracy 应上升。这才证明「数字人自我进化使决策更优」。
   */
  it('真实闭环：earning 蒸馏自动编译 value_shift 后 → accuracy 上升（自我进化使决策更优）', async () => {
    /* baseline：探索略低于稳定 → 推荐偏稳定 → 对 oracle（探索）答错。
     * 探索起点 0.46，稳定 0.5；高质量 earning 单次蒸馏 Δ=+0.05×quality，足以反超。 */
    const explore = os.core.addValue('探索', 0.46);
    os.core.addValue('稳定', 0.5);
    const engine = buildEngine();
    const baseline = await runBenchmark(engine, CASES);
    assert.ok(baseline.accuracy < 1, `baseline 不应已满分（探索弱）：accuracy=${baseline.accuracy}`);

    /* 自我进化：一次高质量任务收益 → 蒸馏器产 value_shift 候选 → 门控自动编译进 core。
     * 全程不调用 updateValueParams：权重由真实闭环改写。 */
    const before = os.core.values.getAll().get(explore.id)!.weight;
    const distilled = os.earningDistiller.distill({
      tenantId: 'default',
      personaId: 'default',
      taskId: 'task-explore-1',
      category: 'exploration',
      qualityScore: 1.0, /* 强信号 → patternAgrees=true → 满足自动编译门 */
      payout: 100,
      targetValue: { valueId: explore.id, currentWeight: before },
    });
    assert.equal(distilled.candidatesIngested, 1, '应产出 1 个 value_shift 候选');
    assert.equal(distilled.results[0]?.status, 'compiled', 'value_shift 应通过门控自动编译');

    /* 校验权重确实被闭环改写（而非测试自己改的）。 */
    const after = os.core.values.getAll().get(explore.id)!.weight;
    assert.ok(after > before, `闭环应抬升探索权重：${before} → ${after}`);

    const learned = await runBenchmark(engine, CASES);
    const cmp = compareBenchmarks(baseline, learned);
    /* 核心命题硬证据：真实自我进化闭环后命中率上升。 */
    assert.ok(cmp.accuracyDelta > 0, `自我进化应提升命中率：baseline=${baseline.accuracy} learned=${learned.accuracy}`);
    assert.equal(learned.accuracy, 1, '闭环后应全部答对 oracle');
  });

  /**
   * 弱证据（框架灵敏度自检）：手动翻转权重，仅证明「权重变化会改变 RuleEngine 排序」。
   * 不代表真实学习——真实学习见上面的闭环测试。命名上不称其为「学习证明」。
   */
  it('框架灵敏度：手动翻转价值权重 → 推荐与 accuracy 随之改变（非真实学习）', async () => {
    const explore = os.core.addValue('探索', 0.2);
    const stable = os.core.addValue('稳定', 0.8);
    const engine = buildEngine();
    const baseline = await runBenchmark(engine, CASES);

    os.core.updateValueParams(explore.id, { weight: 0.9 });
    os.core.updateValueParams(stable.id, { weight: 0.1 });
    const learned = await runBenchmark(engine, CASES);

    const cmp = compareBenchmarks(baseline, learned);
    assert.ok(cmp.accuracyDelta > 0, `权重翻转应改变命中率：baseline=${baseline.accuracy} learned=${learned.accuracy}`);
    assert.equal(learned.accuracy, 1, '探索占绝对优势 → 全推探索备选');
    assert.ok(cmp.recommendationChanges >= 1, '权重翻转改变了推荐');
  });

  it('空 case 集 → 抛错（避免「成功但无证据」）', async () => {
    os.core.addValue('探索', 0.5);
    const engine = buildEngine();
    await assert.rejects(() => runBenchmark(engine, []), /must not be empty/);
  });

  it('fixture 完整性：oracle 不在备选中 → 抛错（暴露 benchmark 数据错误，非「学得差」）', async () => {
    os.core.addValue('探索', 0.5);
    const engine = buildEngine();
    const bad: BenchmarkCase[] = [
      { decisionCase: { id: 'x', title: 't', description: 'd', alternatives: ['A', 'B'] }, expectedAlternative: 'C' },
    ];
    await assert.rejects(() => runBenchmark(engine, bad), /not in alternatives/);
  });

  it('compareBenchmarks：accuracyDelta + 推荐变化；case 集不一致 / 重复 caseId 抛错', () => {
    const mk = (cases: Array<{ caseId: string; recommended: string; correct: boolean }>): BenchmarkMetrics => ({
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
    /* 重复 caseId → 抛错（Codex WP-2 复审：补 duplicate 覆盖，baseline 侧与 learned 侧各一）。 */
    const dup = mk([{ caseId: 'c1', recommended: 'A', correct: true }, { caseId: 'c1', recommended: 'B', correct: true }]);
    assert.throws(() => compareBenchmarks(dup, learned), /duplicate caseId/);
    assert.throws(() => compareBenchmarks(baseline, dup), /duplicate caseId/);
  });
});

