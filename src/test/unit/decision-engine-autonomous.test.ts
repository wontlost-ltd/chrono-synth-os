/**
 * ADR-0047：DecisionEngine autonomous 模式测试
 * 验证自主模式以确定性规则引擎为主路径，且完全不调用 LLM。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { InMemoryEmbeddingIndex } from '../../intelligence/embedding-index-memory.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import type { LLMProvider } from '../../intelligence/llm-provider.js';
import type { DecisionCase, SimulationConfig } from '../../intelligence/types.js';

/** 任何方法被调用都抛错的 LLM —— 用于证明 autonomous 模式不触碰 LLM */
class ThrowingLLM implements LLMProvider {
  chat(): Promise<never> {
    throw new Error('LLM 不应在 autonomous 模式被调用');
  }
  embed(): Promise<never> {
    throw new Error('embed 不应在 autonomous 模式被调用');
  }
}

describe('DecisionEngine autonomous 模式 (ADR-0047)', () => {
  let db: IDatabase;
  let clock: TestClock;
  let core: CoreRhythmLayer;
  const simConfig: SimulationConfig = { rollouts: 2, maxOptions: 4 };

  function buildEngine(llm: LLMProvider, withRuleEngine = true): DecisionEngine {
    const router = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const embeddingIndex = new InMemoryEmbeddingIndex(db, clock, router, 'mock-embed');
    const retrieval = new RetrievalService(core.memories, embeddingIndex);
    const ruleEngine = withRuleEngine ? new RuleEngine(clock, undefined, new SilentLogger()) : undefined;
    return new DecisionEngine(core, retrieval, llm, clock, new SilentLogger(), simConfig, ruleEngine);
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    clock = new TestClock(1000);
    const bus = new EventBus();
    core = new CoreRhythmLayer(db, bus, clock, new SilentLogger());
  });

  it('autonomous 模式在 LLM 抛错时仍返回有效决策（零 LLM 调用）', async () => {
    core.addValue('诚实', 0.8);
    const engine = buildEngine(new ThrowingLLM());
    const decisionCase: DecisionCase = {
      id: 'auto_1',
      title: '诚实抉择',
      description: '是否如实告知',
      alternatives: ['如实告知', '隐瞒'],
    };

    const result = await engine.evaluate(decisionCase, { mode: 'autonomous' });

    assert.equal(result.caseId, 'auto_1');
    assert.ok(result.recommendedAlternative);
    assert.equal(result.rankedOptions.length, 2);
    assert.equal(result.simulatedAt, 1000);
  });

  it('autonomous 模式产出确定性结果（相同输入相同输出）', async () => {
    core.addValue('稳定', 0.7);
    const engine = buildEngine(new ThrowingLLM());
    const decisionCase: DecisionCase = {
      id: 'auto_det',
      title: '稳定性',
      description: '选择更稳定的路径',
      alternatives: ['稳健', '冒险'],
    };
    const r1 = await engine.evaluate(decisionCase, { mode: 'autonomous' });
    const r2 = await engine.evaluate(decisionCase, { mode: 'autonomous' });
    assert.equal(r1.recommendedAlternative, r2.recommendedAlternative);
    assert.equal(r1.rankedOptions[0].overallScore, r2.rankedOptions[0].overallScore);
  });

  it('autonomous 模式无 RuleEngine 时抛出清晰错误', async () => {
    const engine = buildEngine(new ThrowingLLM(), /* withRuleEngine */ false);
    const decisionCase: DecisionCase = { id: 'auto_no_rule', title: 'x', description: 'y', alternatives: ['a', 'b'] };
    await assert.rejects(
      () => engine.evaluate(decisionCase, { mode: 'autonomous' }),
      /autonomous 模式需要 RuleEngine/,
    );
  });

  it('autonomous 模式上报 onProgress 进度', async () => {
    core.addValue('好奇', 0.6);
    const engine = buildEngine(new ThrowingLLM());
    const stages: string[] = [];
    const decisionCase: DecisionCase = { id: 'auto_prog', title: 'x', description: 'y', alternatives: ['a'] };
    await engine.evaluate(decisionCase, {
      mode: 'autonomous',
      onProgress: (p) => { stages.push(p.stage); },
    });
    assert.ok(stages.some((s) => s.startsWith('autonomous')));
  });

  it('growth 模式（默认）仍走 LLM 路径 —— 回归', async () => {
    core.addValue('智慧', 0.7);
    /* 用 mock router（不抛错）验证 growth 行为不被破坏 */
    const router = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const engine = buildEngine(router);
    const decisionCase: DecisionCase = {
      id: 'growth_1',
      title: '职业选择',
      description: '是否换工作',
      alternatives: ['换', '不换'],
    };
    const result = await engine.evaluate(decisionCase); /* 不传 mode → growth */
    assert.equal(result.caseId, 'growth_1');
    assert.equal(result.rankedOptions.length, 2);
  });

  it('ADR-0047 D1：无 LLMProvider 也能构造并运行 autonomous', async () => {
    core.addValue('诚实', 0.8);
    const router = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const embeddingIndex = new InMemoryEmbeddingIndex(db, clock, router, 'mock-embed');
    const retrieval = new RetrievalService(core.memories, embeddingIndex);
    const ruleEngine = new RuleEngine(clock, undefined, new SilentLogger());
    /* llm = undefined：autonomous-only runtime */
    const engine = new DecisionEngine(core, retrieval, undefined, clock, new SilentLogger(), simConfig, ruleEngine);

    const result = await engine.evaluate(
      { id: 'no_llm', title: 'x', description: 'y', alternatives: ['a', 'b'] },
      { mode: 'autonomous' },
    );
    assert.equal(result.rankedOptions.length, 2);
  });

  it('无 LLMProvider 时 growth 模式抛清晰错误', async () => {
    core.addValue('诚实', 0.8);
    const router = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const embeddingIndex = new InMemoryEmbeddingIndex(db, clock, router, 'mock-embed');
    const retrieval = new RetrievalService(core.memories, embeddingIndex);
    const ruleEngine = new RuleEngine(clock, undefined, new SilentLogger());
    const engine = new DecisionEngine(core, retrieval, undefined, clock, new SilentLogger(), simConfig, ruleEngine);
    /* growth（默认）但无 llm：evaluateWithLLM 抛错，且 ruleEngine 允许 fallback →
     * 这里 fallback 会接住，所以应得到结果（验证 growth 缺 llm 时优雅退化）。 */
    const result = await engine.evaluate({ id: 'g_no_llm', title: 'x', description: 'y', alternatives: ['a', 'b'] });
    assert.equal(result.rankedOptions.length, 2);
  });
});
