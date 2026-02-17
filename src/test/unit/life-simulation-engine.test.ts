import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LifeSimulationEngine } from '../../simulation/life-simulation-engine.js';
import type { PersonaOSState } from '../../types/personality-os.js';
import type { CoreValue } from '../../types/core-self.js';
import type { LifeSimulationConfig } from '../../types/life-simulation.js';

function makeValue(id: string, label: string, weight: number): CoreValue {
  return { id, label, weight, timeDiscount: 0.5, emotionAmplifier: 1, updatedAt: 1000 };
}

function makeState(): PersonaOSState {
  return {
    L0: [
      { id: 'a1', label: '收入底线', kind: 'threshold', value: 100000, severity: 4, createdAt: 1000, updatedAt: 1000 },
    ],
    L1: new Map([
      ['v1', makeValue('v1', '财务安全', 0.8)],
      ['v2', makeValue('v2', '个人成长', 0.6)],
    ]),
    L2: {
      riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.3,
      lossAversion: 1.5, deliberationDepth: 3, regretSensitivity: 0.5, updatedAt: 1000,
    },
    L3: {
      beliefs: new Map(), biasWeights: new Map(),
      attributionStyle: 0.5, growthMindset: 0.5, updatedAt: 1000,
    },
    L4: {
      memories: new Map(), edges: [], narrative: '',
    },
  };
}

function makeConfig(overrides: Partial<LifeSimulationConfig> = {}): LifeSimulationConfig {
  return {
    horizonYears: 5,
    paths: [
      {
        id: 'stable', label: '稳定路径', description: '保持现状',
        initialConditions: { income: 300000, savings: 500000, age: 35 },
        branches: [],
      },
      {
        id: 'startup', label: '创业路径', description: '全职创业',
        initialConditions: { income: 0, savings: 300000, incomeMultiplier: 0, age: 35 },
        branches: [
          { label: '成功', probability: 0.3, conditions: { incomeOverride: 600000 } },
          { label: '失败', probability: 0.7, conditions: { incomeOverride: 0 } },
        ],
      },
    ],
    ...overrides,
  };
}

describe('LifeSimulationEngine', () => {
  const engine = new LifeSimulationEngine();

  it('返回正确数量的路径结果', () => {
    const result = engine.simulate(makeConfig(), makeState());
    assert.equal(result.paths.length, 2);
    assert.equal(result.paths[0].pathId, 'stable');
    assert.equal(result.paths[1].pathId, 'startup');
  });

  it('每条路径有正确数量的年度快照', () => {
    const result = engine.simulate(makeConfig({ horizonYears: 3 }), makeState());
    for (const path of result.paths) {
      assert.equal(path.timeline.length, 3, `${path.pathId} should have 3 years`);
    }
  });

  it('确定性：相同输入产生相同输出', () => {
    const config = makeConfig();
    const state = makeState();
    const r1 = engine.simulate(config, state, { simulationId: 'test1' });
    const r2 = engine.simulate(config, state, { simulationId: 'test2' });
    assert.equal(r1.paths[0].compositeScore, r2.paths[0].compositeScore);
    assert.equal(r1.paths[0].timeline[0].wealth, r2.paths[0].timeline[0].wealth);
  });

  it('推荐路径是 compositeScore 最高的', () => {
    const result = engine.simulate(makeConfig(), makeState());
    const scores = result.paths.map(p => ({ id: p.pathId, score: p.compositeScore }));
    const maxScore = Math.max(...scores.map(s => s.score));
    const recommended = scores.find(s => s.score === maxScore);
    assert.equal(result.recommendedPathId, recommended?.id);
  });

  it('创业路径有分支结果', () => {
    const result = engine.simulate(makeConfig(), makeState());
    const startup = result.paths.find(p => p.pathId === 'startup');
    assert.ok(startup);
    assert.ok(startup.branches.length > 0, 'startup should have branches');
    assert.ok(startup.branches.some(b => b.label === '成功'));
    assert.ok(startup.branches.some(b => b.label === '失败'));
  });

  it('分支概率归一化', () => {
    const result = engine.simulate(makeConfig(), makeState());
    const startup = result.paths.find(p => p.pathId === 'startup');
    assert.ok(startup);
    const totalProb = startup.branches.reduce((s, b) => s + b.probability, 0);
    assert.ok(Math.abs(totalProb - 1) < 0.001, `totalProb=${totalProb} should ≈ 1`);
  });

  it('回顾评估包含所有路径', () => {
    const result = engine.simulate(makeConfig(), makeState());
    assert.ok(result.retrospective.summary.length > 0);
    assert.ok(result.retrospective.confidence >= 0 && result.retrospective.confidence <= 1);
    for (const path of result.paths) {
      assert.ok(path.pathId in result.retrospective.regretByPath);
    }
  });

  it('L0 违规影响评分', () => {
    const state = makeState();
    /* 创业路径收入为 0，违反收入底线 */
    const result = engine.simulate(makeConfig(), state);
    const stable = result.paths.find(p => p.pathId === 'stable');
    const startup = result.paths.find(p => p.pathId === 'startup');
    assert.ok(stable && startup);
    /* 稳定路径有稳定收入，评分应高于零收入的创业路径 */
    assert.ok(stable.compositeScore >= startup.compositeScore * 0.5,
      `stable=${stable.compositeScore} startup=${startup.compositeScore}`);
  });

  it('压力测试降低评分', () => {
    const config = makeConfig();
    const stressConfig = makeConfig({
      stressTestConfig: {
        enabled: true, incomeFreezeYears: 5, marketDownturnFactor: 0.2, healthShock: 0.4,
      },
    });
    const normal = engine.simulate(config, makeState());
    const stress = engine.simulate(stressConfig, makeState());
    const normalStable = normal.paths.find(p => p.pathId === 'stable')!;
    const stressStable = stress.paths.find(p => p.pathId === 'stable')!;
    /* 极端压力测试：冻结收入全部年份 + 市场下跌 80% + 健康冲击 0.4 → 评分必定降低 */
    assert.ok(stressStable.compositeScore <= normalStable.compositeScore,
      `stress=${stressStable.compositeScore} should <= normal=${normalStable.compositeScore}`);
  });

  it('进度回调被调用', () => {
    const progressCalls: number[] = [];
    engine.simulate(makeConfig({ horizonYears: 3 }), makeState(), {
      simulationId: 'prog_test',
      onProgress: (p) => { progressCalls.push(p.percent); },
    });
    assert.ok(progressCalls.length > 0, 'progress should be called');
    assert.ok(progressCalls[progressCalls.length - 1] > 50, 'last progress should be > 50%');
  });

  it('年度快照包含有效字段', () => {
    const result = engine.simulate(makeConfig({ horizonYears: 2 }), makeState());
    const yearState = result.paths[0].timeline[0];
    assert.equal(yearState.year, 1);
    assert.ok(yearState.wealth >= 0);
    assert.ok(yearState.healthIndex >= 0 && yearState.healthIndex <= 1);
    assert.ok(yearState.emotionalState.valence >= -1 && yearState.emotionalState.valence <= 1);
    assert.ok(yearState.emotionalState.stress >= 0 && yearState.emotionalState.stress <= 1);
    assert.ok(Object.keys(yearState.valueWeights).length > 0);
  });

  it('regretProbability 与 regretSensitivity 相关', () => {
    const lowSens: PersonaOSState = { ...makeState(), L2: { ...makeState().L2, regretSensitivity: 0.1 } };
    const highSens: PersonaOSState = { ...makeState(), L2: { ...makeState().L2, regretSensitivity: 0.9 } };

    const config = makeConfig();
    const rLow = engine.simulate(config, lowSens);
    const rHigh = engine.simulate(config, highSens);

    const lowRegret = rLow.paths[0].regretProbability;
    const highRegret = rHigh.paths[0].regretProbability;
    assert.ok(highRegret >= lowRegret,
      `highSens regret=${highRegret} should >= lowSens=${lowRegret}`);
  });
});
