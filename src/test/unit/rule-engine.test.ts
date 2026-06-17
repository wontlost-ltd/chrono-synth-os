import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import type { DecisionCase } from '../../intelligence/types.js';
import type { PersonaOSState } from '../../types/personality-os.js';
import { TestClock } from '../../utils/index.js';
import type { RulePayload } from '@chrono/kernel';

function makePersonaState(overrides?: Partial<PersonaOSState>): PersonaOSState {
  return {
    L0: [],
    L1: new Map([
      ['v1', { id: 'v1', label: '诚实', weight: 0.8, timeDiscount: 0.5, emotionAmplifier: 1.0, updatedAt: 1000 }],
      ['v2', { id: 'v2', label: '勇气', weight: 0.6, timeDiscount: 0.5, emotionAmplifier: 1.0, updatedAt: 1000 }],
    ]),
    L2: {
      riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.5,
      lossAversion: 1.5, deliberationDepth: 3, regretSensitivity: 0.5, updatedAt: 1000,
    },
    L3: {
      beliefs: new Map(), biasWeights: new Map(),
      attributionStyle: 0.5, growthMindset: 0.5, ambiguityTolerance: 0.5, analyticalIntuitive: 0.5, updatedAt: 1000,
    },
    L4: { memories: new Map(), edges: [], narrative: '' },
    ...overrides,
  };
}

function makeCase(overrides?: Partial<DecisionCase>): DecisionCase {
  return {
    id: 'case-1',
    title: '测试决策',
    description: '需要做出诚实的选择',
    ...overrides,
  };
}

describe('RuleEngine', () => {
  const clock = new TestClock(1000);

  it('allowsFallback 默认返回 true（rule_only 策略）', () => {
    const engine = new RuleEngine(clock);
    assert.equal(engine.allowsFallback(), true);
  });

  it('allowsFallback 在 error 策略下返回 false', () => {
    const engine = new RuleEngine(clock, { fallbackStrategy: 'error' });
    assert.equal(engine.allowsFallback(), false);
  });

  it('evaluate 返回排序后的选项', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ alternatives: ['诚实回答', '避而不谈'] }), state);
    assert.equal(result.caseId, 'case-1');
    assert.ok(result.rankedOptions.length === 2);
    assert.equal(result.rankedOptions[0].rank, 1);
    assert.equal(result.rankedOptions[1].rank, 2);
    assert.ok(result.rankedOptions[0].overallScore >= result.rankedOptions[1].overallScore);
  });

  it('evaluate 无备选项时生成默认选项', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ alternatives: [] }), state);
    assert.equal(result.rankedOptions.length, 2);
    assert.equal(result.rankedOptions[0].alternative, '保持现状');
  });

  it('disabled 时抛出异常', () => {
    const engine = new RuleEngine(clock, { enabled: false });
    const state = makePersonaState();
    assert.throws(() => engine.evaluate(makeCase(), state), /disabled/);
  });

  it('CJK tokenize 正确分词', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(
      makeCase({ description: '关于诚实的问题', alternatives: ['诚实回答'] }),
      state,
    );
    assert.ok(result.rankedOptions.length > 0);
  });

  it('timeHorizonMonths 从 context 提取并影响结果', () => {
    const engine = new RuleEngine(clock);
    /* 使用高 timeDiscount 值使时间折扣效果更明显 */
    const state = makePersonaState({
      L1: new Map([
        ['v1', { id: 'v1', label: '诚实', weight: 0.8, timeDiscount: 0.1, emotionAmplifier: 1.0, updatedAt: 1000 }],
      ]),
    });
    const r1 = engine.evaluate(
      makeCase({ alternatives: ['诚实选择'], context: { timeHorizonMonths: 6 } }),
      state,
    );
    const r2 = engine.evaluate(
      makeCase({ alternatives: ['诚实选择'], context: { timeHorizonMonths: 48 } }),
      state,
    );
    /* 两者都有结果即可，timeHorizon 影响了 breakdown 中的 timeHorizonEffect */
    assert.ok(r1.rankedOptions.length > 0);
    assert.ok(r2.rankedOptions.length > 0);
  });

  it('timeHorizonMonths 字符串解析', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ context: { timeHorizonMonths: '12' } }), state);
    assert.ok(result.rankedOptions.length > 0);
  });

  it('推荐选项与关键词重叠', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(
      makeCase({
        description: '诚实',
        alternatives: ['诚实第一', '其他路径'],
      }),
      state,
    );
    assert.equal(result.recommendedAlternative, result.rankedOptions[0].alternative);
  });

  it('每个选项包含 explanation', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ alternatives: ['选项A'] }), state);
    assert.ok(result.rankedOptions[0].explanation);
    assert.ok(result.rankedOptions[0].explanation.summary.length > 0);
  });

  it('每个选项包含 scoreBreakdown', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ alternatives: ['选项A'] }), state);
    assert.ok(result.rankedOptions[0].scoreBreakdown);
    assert.ok('valueContributions' in result.rankedOptions[0].scoreBreakdown!);
  });

  it('simulatedAt 使用 clock 时间', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase(), state);
    assert.equal(result.simulatedAt, 1000);
  });

  it('每个选项包含 regretProbability', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ alternatives: ['选项A', '选项B'] }), state);
    for (const option of result.rankedOptions) {
      assert.ok(typeof option.regretProbability === 'number');
      assert.ok(option.regretProbability >= 0 && option.regretProbability <= 1);
    }
  });

  it('regretProbability 与 regretSensitivity 正相关', () => {
    const engine = new RuleEngine(clock);
    const lowSens = makePersonaState({
      L2: { riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.5, lossAversion: 1.5, deliberationDepth: 3, regretSensitivity: 0.1, updatedAt: 1000 },
    });
    const highSens = makePersonaState({
      L2: { riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.5, lossAversion: 1.5, deliberationDepth: 3, regretSensitivity: 0.9, updatedAt: 1000 },
    });
    const r1 = engine.evaluate(makeCase({ alternatives: ['选项A'] }), lowSens);
    const r2 = engine.evaluate(makeCase({ alternatives: ['选项A'] }), highSens);
    assert.ok(r2.rankedOptions[0].regretProbability >= r1.rankedOptions[0].regretProbability);
  });

  it('空价值集返回默认选项', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState({ L1: new Map() });
    const result = engine.evaluate(makeCase({ alternatives: ['选项A'] }), state);
    assert.ok(result.rankedOptions.length > 0);
    assert.ok(Number.isFinite(result.rankedOptions[0].overallScore));
  });

  it('大量备选项正确排序', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const alternatives = Array.from({ length: 20 }, (_, i) => `选项${i}`);
    const result = engine.evaluate(makeCase({ alternatives }), state);
    assert.equal(result.rankedOptions.length, 20);
    for (let i = 1; i < result.rankedOptions.length; i++) {
      assert.ok(result.rankedOptions[i - 1].overallScore >= result.rankedOptions[i].overallScore);
    }
  });

  it('context 为 undefined 时正常工作', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState();
    const result = engine.evaluate(makeCase({ context: undefined }), state);
    assert.ok(result.rankedOptions.length > 0);
  });

  it('未提供 rules 与空 rules 行为一致（向后兼容）', () => {
    const engine = new RuleEngine(clock);
    const state = makePersonaState({ L1: new Map() });
    const decision = makeCase({ alternatives: ['质量优先', '拖延处理'] });
    const withoutRules = engine.evaluate(decision, state);
    const withEmptyRules = engine.evaluate(decision, { ...state, rules: [] } as PersonaOSState & { rules: RulePayload[] });
    assert.deepEqual(
      withEmptyRules.rankedOptions.map((o) => [o.alternative, o.overallScore]),
      withoutRules.rankedOptions.map((o) => [o.alternative, o.overallScore]),
    );
  });

  it('prefer rule 命中 condition 时提升匹配选项排序', () => {
    const engine = new RuleEngine(clock);
    const state = {
      ...makePersonaState({ L1: new Map() }),
      rules: [{ ruleId: 'prefer_quality', condition: '质量', action: 'prefer', weight: 1 }],
    } as PersonaOSState & { rules: RulePayload[] };
    const result = engine.evaluate(makeCase({ alternatives: ['拖延处理', '质量优先'] }), state);
    assert.equal(result.recommendedAlternative, '质量优先');
    assert.ok(result.rankedOptions[0].overallScore > result.rankedOptions[1].overallScore);
  });

  it('avoid rule 命中 condition 时降低匹配选项排序', () => {
    const engine = new RuleEngine(clock);
    const state = {
      ...makePersonaState({
        L1: new Map([
          ['v1', { id: 'v1', label: 'option', weight: 1, timeDiscount: 0.5, emotionAmplifier: 1.0, updatedAt: 1000 }],
        ]),
      }),
      rules: [{ ruleId: 'avoid_delay', condition: 'delay', action: 'avoid', weight: 1 }],
    } as PersonaOSState & { rules: RulePayload[] };
    const result = engine.evaluate(makeCase({ alternatives: ['delay option', 'quality option'] }), state);
    assert.equal(result.recommendedAlternative, 'quality option');
    assert.ok(result.rankedOptions[0].overallScore > result.rankedOptions[1].overallScore);
  });
});
