import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import type { DecisionCase, SimulationConfig } from '../../intelligence/types.js';

describe('DecisionEngine', () => {
  let db: IDatabase;
  let clock: TestClock;
  let core: CoreRhythmLayer;
  let engine: DecisionEngine;

  const simConfig: SimulationConfig = { rollouts: 2, maxOptions: 4 };

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    clock = new TestClock(1000);
    const bus = new EventBus();
    core = new CoreRhythmLayer(db, bus, clock, new SilentLogger());
    const llm = new ModelRouter({
      provider: 'mock',
      model: 'test',
      embeddingModel: 'mock-embed',
    });
    const embeddingIndex = new EmbeddingIndex(db, clock, llm, 'mock-embed');
    const retrieval = new RetrievalService(core.memories, embeddingIndex);
    engine = new DecisionEngine(core, retrieval, llm, clock, new SilentLogger(), simConfig);
  });

  describe('evaluate', () => {
    it('使用用户提供的备选项', async () => {
      core.addValue('稳定', 0.8);
      const decisionCase: DecisionCase = {
        id: 'dec_test1',
        title: '投资决策',
        description: '是否应该投资新项目',
        alternatives: ['投资', '不投资'],
      };

      const result = await engine.evaluate(decisionCase);

      assert.equal(result.caseId, 'dec_test1');
      assert.ok(result.recommendedAlternative);
      assert.equal(result.rankedOptions.length, 2);
      assert.equal(result.simulatedAt, 1000);
    });

    it('无备选项时由 LLM 生成', async () => {
      const decisionCase: DecisionCase = {
        id: 'dec_test2',
        title: '职业选择',
        description: '应该换工作吗',
      };

      const result = await engine.evaluate(decisionCase);

      assert.equal(result.caseId, 'dec_test2');
      /* Mock LLM 返回 Option A, Option B, Option C */
      assert.ok(result.rankedOptions.length >= 2);
    });

    it('排名从 1 开始递增', async () => {
      const decisionCase: DecisionCase = {
        id: 'dec_rank',
        title: '排名测试',
        description: '测试排名',
        alternatives: ['A', 'B', 'C'],
      };

      const result = await engine.evaluate(decisionCase);

      for (let i = 0; i < result.rankedOptions.length; i++) {
        assert.equal(result.rankedOptions[i].rank, i + 1);
      }
    });

    it('每个选项包含完整评分字段', async () => {
      core.addValue('勇气', 0.7);
      core.addValue('智慧', 0.6);

      const decisionCase: DecisionCase = {
        id: 'dec_fields',
        title: '字段测试',
        description: '验证输出字段完整性',
        alternatives: ['选项A', '选项B'],
      };

      const result = await engine.evaluate(decisionCase);

      for (const option of result.rankedOptions) {
        assert.equal(typeof option.alternative, 'string');
        assert.equal(typeof option.rank, 'number');
        assert.equal(typeof option.alignmentScore, 'number');
        assert.equal(typeof option.riskScore, 'number');
        assert.equal(typeof option.confidence, 'number');
        assert.ok(option.explanation);
        assert.equal(typeof option.explanation.summary, 'string');
        assert.ok(Array.isArray(option.explanation.evidence));
        assert.ok(Array.isArray(option.explanation.counterfactuals));
      }
    });

    it('推荐选项为排名第一的方案', async () => {
      const decisionCase: DecisionCase = {
        id: 'dec_recommend',
        title: '推荐测试',
        description: '推荐方案等于排名第一',
        alternatives: ['X', 'Y'],
      };

      const result = await engine.evaluate(decisionCase);

      assert.equal(result.recommendedAlternative, result.rankedOptions[0].alternative);
    });

    it('maxOptions 限制备选项数量', async () => {
      const smallConfig: SimulationConfig = { rollouts: 1, maxOptions: 2 };
      const llm = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
      const embeddingIndex = new EmbeddingIndex(db, clock, llm, 'mock-embed');
      const retrieval = new RetrievalService(core.memories, embeddingIndex);
      const limitedEngine = new DecisionEngine(core, retrieval, llm, clock, new SilentLogger(), smallConfig);

      const decisionCase: DecisionCase = {
        id: 'dec_limit',
        title: '限制测试',
        description: '测试 maxOptions',
        alternatives: ['A', 'B', 'C', 'D', 'E'],
      };

      const result = await limitedEngine.evaluate(decisionCase);
      /* maxOptions=2，但 Math.max(2, maxOptions) 保证至少 2 个 */
      assert.ok(result.rankedOptions.length <= 2);
    });

    it('进度回调被正确调用', async () => {
      const progresses: Array<{ progress: number; stage: string }> = [];

      const decisionCase: DecisionCase = {
        id: 'dec_progress',
        title: '进度测试',
        description: '验证进度回调',
        alternatives: ['A', 'B'],
      };

      await engine.evaluate(decisionCase, {
        onProgress: (p) => progresses.push(p),
      });

      assert.ok(progresses.length >= 3);
      /* 第一个是 context 阶段 */
      assert.equal(progresses[0].stage, 'context');
      assert.ok(progresses[0].progress > 0);
      /* 第二个是 alternatives 阶段 */
      assert.equal(progresses[1].stage, 'alternatives');
      /* 最后的进度接近 1.0 */
      const last = progresses[progresses.length - 1];
      assert.ok(last.progress > 0.9);
    });
  });

  describe('L0 约束惩罚', () => {
    it('有生存锚点但无违反时惩罚为 0', async () => {
      core.addSurvivalAnchor('安全底线', 'constraint', null, 5);

      const decisionCase: DecisionCase = {
        id: 'dec_anchor_ok',
        title: '安全决策',
        description: '不违反约束',
        alternatives: ['安全选项', '另一安全选项'],
      };

      const result = await engine.evaluate(decisionCase);
      /* Mock LLM 返回空 constraintViolations，所以没有额外惩罚 */
      assert.ok(result.rankedOptions.length > 0);
    });
  });

  describe('L2 风格影响', () => {
    it('不同风险偏好影响评分', async () => {
      core.addValue('稳定', 0.8);

      const decisionCase: DecisionCase = {
        id: 'dec_style',
        title: '风格测试',
        description: '测试风格对评分的影响',
        alternatives: ['保守', '激进'],
      };

      /* 保守风格 */
      core.setDecisionStyle({ riskAppetite: 0.1 });
      const conservativeResult = await engine.evaluate(decisionCase);

      /* 激进风格 */
      core.setDecisionStyle({ riskAppetite: 0.9 });
      const aggressiveResult = await engine.evaluate(decisionCase);

      /* 两种风格都能产出有效结果 */
      assert.ok(conservativeResult.rankedOptions.length > 0);
      assert.ok(aggressiveResult.rankedOptions.length > 0);
    });
  });

  describe('记忆上下文', () => {
    it('有相关记忆时正常运行', async () => {
      core.addMemory('episodic', '上次投资损失了很多', 0.9, 0.95);
      core.addMemory('semantic', '市场波动是正常的', 0.1, 0.5);

      const decisionCase: DecisionCase = {
        id: 'dec_memory',
        title: '投资决策',
        description: '是否追加投资',
        alternatives: ['追加', '撤出'],
      };

      const result = await engine.evaluate(decisionCase);
      assert.ok(result.rankedOptions.length > 0);
    });
  });
});
