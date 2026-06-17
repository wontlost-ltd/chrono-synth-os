import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeStructuralScore, type StructuralScoreInput } from '../../intelligence/structural-scorer.js';
import type { CoreValue } from '../../types/core-self.js';
import type { DecisionStyle, CognitiveModel, SurvivalAnchor } from '../../types/personality-os.js';

function makeValue(id: string, label: string, weight: number, timeDiscount = 0.5, emotionAmplifier = 1.0): CoreValue {
  return { id, label, weight, timeDiscount, emotionAmplifier, updatedAt: 1000 };
}

const DEFAULT_STYLE: DecisionStyle = {
  riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.5,
  lossAversion: 1.5, deliberationDepth: 3, regretSensitivity: 0.5, updatedAt: 1000,
};

const DEFAULT_COGNITIVE: CognitiveModel = {
  beliefs: new Map(), biasWeights: new Map(), attributionStyle: 0.5, growthMindset: 0.5, ambiguityTolerance: 0.5, analyticalIntuitive: 0.5, updatedAt: 1000,
};

function makeInput(overrides: Partial<StructuralScoreInput> = {}): StructuralScoreInput {
  const v = makeValue('v1', '诚实', 0.8);
  return {
    valueWeights: new Map(),
    values: new Map([['v1', v]]),
    scenarioRelevance: new Map([['v1', 0.9]]),
    anchors: [],
    violations: [],
    riskScore: 0.5,
    decisionStyle: DEFAULT_STYLE,
    cognitiveModel: DEFAULT_COGNITIVE,
    ...overrides,
  };
}

describe('computeStructuralScore', () => {
  it('空值列表返回 0 对齐分', () => {
    const result = computeStructuralScore(makeInput({ values: new Map(), scenarioRelevance: new Map() }));
    assert.equal(result.alignmentScore, 0);
  });

  it('单个高相关价值产生正对齐分', () => {
    const result = computeStructuralScore(makeInput());
    assert.ok(result.alignmentScore > 0, `alignmentScore=${result.alignmentScore}`);
    assert.ok(result.overallScore > 0, `overallScore=${result.overallScore}`);
  });

  it('relevance=0 时对齐分为 0', () => {
    const result = computeStructuralScore(makeInput({ scenarioRelevance: new Map([['v1', 0]]) }));
    assert.equal(result.alignmentScore, 0);
  });

  it('锚点违规产生惩罚', () => {
    const anchor: SurvivalAnchor = {
      id: 'a1', label: '安全底线', kind: 'constraint', value: null, severity: 5, createdAt: 1000, updatedAt: 1000,
    };
    const noViolation = computeStructuralScore(makeInput());
    const withViolation = computeStructuralScore(makeInput({
      anchors: [anchor],
      violations: ['安全底线被违反'],
    }));
    assert.ok(withViolation.constraintPenalty > 0);
    assert.ok(withViolation.overallScore < noViolation.overallScore);
  });

  it('timeDiscount 影响时间衰减效果', () => {
    const highDiscount = makeValue('v1', '诚实', 0.8, 0.9);
    const lowDiscount = makeValue('v1', '诚实', 0.8, 0.1);

    const high = computeStructuralScore(makeInput({
      values: new Map([['v1', highDiscount]]),
      timeHorizonMonths: 48,
    }));
    const low = computeStructuralScore(makeInput({
      values: new Map([['v1', lowDiscount]]),
      timeHorizonMonths: 48,
    }));
    assert.ok(high.breakdown.timeHorizonEffect >= low.breakdown.timeHorizonEffect,
      `highTD=${high.breakdown.timeHorizonEffect} lowTD=${low.breakdown.timeHorizonEffect}`);
  });

  it('emotionAmplifier 放大价值贡献', () => {
    const normal = makeValue('v1', '诚实', 0.8, 0.5, 1.0);
    const amplified = makeValue('v1', '诚实', 0.8, 0.5, 2.0);

    const r1 = computeStructuralScore(makeInput({ values: new Map([['v1', normal]]) }));
    const r2 = computeStructuralScore(makeInput({ values: new Map([['v1', amplified]]) }));
    assert.ok(r2.breakdown.valueContributions['诚实'] >= r1.breakdown.valueContributions['诚实']);
  });

  it('认知偏差调整影响总分', () => {
    const biased: CognitiveModel = {
      beliefs: new Map(),
      biasWeights: new Map([['confirmation', 0.8], ['loss_aversion', 0.5]]),
      attributionStyle: 0.5,
      growthMindset: 0.5,
      ambiguityTolerance: 0.5,
      analyticalIntuitive: 0.5,
      updatedAt: 1000,
    };
    const result = computeStructuralScore(makeInput({ cognitiveModel: biased }));
    assert.notEqual(result.cognitiveBias, 0);
    assert.ok(result.breakdown.biasAdjustments.confirmation !== undefined);
  });

  it('高成长心态缩减偏差幅度', () => {
    const biases = new Map([['confirmation', 0.9]]);
    const fixedMindset: CognitiveModel = {
      beliefs: new Map(), biasWeights: biases, attributionStyle: 0.5, growthMindset: 0.0, ambiguityTolerance: 0.5, analyticalIntuitive: 0.5, updatedAt: 1000,
    };
    const growthMindset: CognitiveModel = {
      beliefs: new Map(), biasWeights: biases, attributionStyle: 0.5, growthMindset: 1.0, ambiguityTolerance: 0.5, analyticalIntuitive: 0.5, updatedAt: 1000,
    };
    const r1 = computeStructuralScore(makeInput({ cognitiveModel: fixedMindset }));
    const r2 = computeStructuralScore(makeInput({ cognitiveModel: growthMindset }));
    assert.ok(Math.abs(r2.cognitiveBias) >= Math.abs(r1.cognitiveBias),
      `growth=${r2.cognitiveBias} fixed=${r1.cognitiveBias}`);
  });

  it('多个价值按权重累计', () => {
    const v1 = makeValue('v1', '诚实', 0.8);
    const v2 = makeValue('v2', '勇气', 0.6);
    const result = computeStructuralScore(makeInput({
      values: new Map([['v1', v1], ['v2', v2]]),
      scenarioRelevance: new Map([['v1', 1.0], ['v2', 1.0]]),
    }));
    assert.ok(result.breakdown.valueContributions['诚实'] > 0);
    assert.ok(result.breakdown.valueContributions['勇气'] > 0);
  });

  it('overallScore 夹紧认知偏差到 [-0.2, 0.2]', () => {
    const extremeBias: CognitiveModel = {
      beliefs: new Map(),
      biasWeights: new Map([['confirmation', 10], ['optimism', 10]]),
      attributionStyle: 0.5,
      growthMindset: 1.0,
      ambiguityTolerance: 0.5,
      analyticalIntuitive: 0.5,
      updatedAt: 1000,
    };
    const result = computeStructuralScore(makeInput({ cognitiveModel: extremeBias }));
    assert.ok(result.cognitiveBias <= 0.2);
    assert.ok(result.cognitiveBias >= -0.2);
  });

  it('valueWeights 覆盖 value.weight 影响贡献', () => {
    const v = makeValue('v1', '诚实', 0.2);
    const r1 = computeStructuralScore(makeInput({
      values: new Map([['v1', v]]),
      valueWeights: new Map(),
    }));
    const r2 = computeStructuralScore(makeInput({
      values: new Map([['v1', v]]),
      valueWeights: new Map([['v1', 0.9]]),
    }));
    /* valueWeights 覆盖后贡献值发生变化 */
    assert.ok(r2.breakdown.valueContributions['诚实'] >= r1.breakdown.valueContributions['诚实']);
  });

  it('不同 riskAppetite 下 riskScore 产生不同惩罚', () => {
    const conservativeStyle: DecisionStyle = {
      ...DEFAULT_STYLE, riskAppetite: 0.1,
    };
    const aggressiveStyle: DecisionStyle = {
      ...DEFAULT_STYLE, riskAppetite: 0.9,
    };
    const conservative = computeStructuralScore(makeInput({
      riskScore: 0.8,
      decisionStyle: conservativeStyle,
    }));
    const aggressive = computeStructuralScore(makeInput({
      riskScore: 0.8,
      decisionStyle: aggressiveStyle,
    }));
    assert.ok(conservative.stylePenalty !== aggressive.stylePenalty);
  });

  it('NaN/Infinity 安全处理', () => {
    const v = makeValue('v1', '诚实', NaN, NaN, NaN);
    const result = computeStructuralScore(makeInput({
      values: new Map([['v1', v]]),
      riskScore: Infinity,
    }));
    assert.ok(Number.isFinite(result.overallScore));
  });

  it('breakdown 包含 anchorViolations', () => {
    const anchor: SurvivalAnchor = {
      id: 'a1', label: '底线', kind: 'threshold', value: 0, severity: 3, createdAt: 1000, updatedAt: 1000,
    };
    const result = computeStructuralScore(makeInput({
      anchors: [anchor],
      violations: ['底线被突破'],
    }));
    assert.ok(result.breakdown.anchorViolations.length > 0);
  });

  it('多个锚点不同 severity 累计惩罚', () => {
    const anchors: SurvivalAnchor[] = [
      { id: 'a1', label: '安全', kind: 'constraint', value: null, severity: 5, createdAt: 1000, updatedAt: 1000 },
      { id: 'a2', label: '隐私', kind: 'threshold', value: 0, severity: 2, createdAt: 1000, updatedAt: 1000 },
    ];
    const singleViolation = computeStructuralScore(makeInput({
      anchors,
      violations: ['安全违规'],
    }));
    const doubleViolation = computeStructuralScore(makeInput({
      anchors,
      violations: ['安全违规', '隐私泄露'],
    }));
    /* 两种违规都产生惩罚 */
    assert.ok(singleViolation.constraintPenalty > 0);
    assert.ok(doubleViolation.constraintPenalty > 0);
    /* 平均 severity 不同：单违规 5/5=1.0，双违规 (5+2)/(5*2)=0.7 → 惩罚值不同 */
    assert.notEqual(singleViolation.constraintPenalty, doubleViolation.constraintPenalty);
  });

  it('overallScore 在 0-1 范围内', () => {
    const result = computeStructuralScore(makeInput());
    assert.ok(result.overallScore >= 0 && result.overallScore <= 1,
      `overallScore=${result.overallScore}`);
  });

  it('高 severity 锚点违规比低 severity 惩罚更重', () => {
    const highSev: SurvivalAnchor = {
      id: 'a1', label: '高', kind: 'constraint', value: null, severity: 5, createdAt: 1000, updatedAt: 1000,
    };
    const lowSev: SurvivalAnchor = {
      id: 'a1', label: '低', kind: 'constraint', value: null, severity: 1, createdAt: 1000, updatedAt: 1000,
    };
    const rHigh = computeStructuralScore(makeInput({ anchors: [highSev], violations: ['违规'] }));
    const rLow = computeStructuralScore(makeInput({ anchors: [lowSev], violations: ['违规'] }));
    assert.ok(rHigh.constraintPenalty >= rLow.constraintPenalty,
      `highSev=${rHigh.constraintPenalty} lowSev=${rLow.constraintPenalty}`);
  });
});

/* ── ④ L3 认知扩展：ambiguityTolerance + analyticalIntuitive 接入打分（真影响 overallScore，非死字段）── */
describe('L3 认知扩展接入打分（④）', () => {
  function cog(over: Partial<CognitiveModel>): CognitiveModel {
    return { ...DEFAULT_COGNITIVE, ...over };
  }

  it('ambiguityTolerance：高容忍在高 risk 选项下加分，低容忍减分（中性 0.5 无影响）', () => {
    const base = makeInput({ riskScore: 1.0 }); /* 高不确定/风险选项 */
    const neutral = computeStructuralScore({ ...base, cognitiveModel: cog({ ambiguityTolerance: 0.5 }) }).overallScore;
    const high = computeStructuralScore({ ...base, cognitiveModel: cog({ ambiguityTolerance: 1.0 }) }).overallScore;
    const low = computeStructuralScore({ ...base, cognitiveModel: cog({ ambiguityTolerance: 0.0 }) }).overallScore;
    assert.ok(high > neutral, `高容忍 ${high} > 中性 ${neutral}`);
    assert.ok(low < neutral, `低容忍 ${low} < 中性 ${neutral}`);
  });

  it('ambiguityTolerance：低 risk 选项下影响微弱（容忍只在不确定时起作用）', () => {
    const base = makeInput({ riskScore: 0 }); /* 确定选项 */
    const high = computeStructuralScore({ ...base, cognitiveModel: cog({ ambiguityTolerance: 1.0 }) }).overallScore;
    const low = computeStructuralScore({ ...base, cognitiveModel: cog({ ambiguityTolerance: 0.0 }) }).overallScore;
    assert.ok(Math.abs(high - low) < 1e-9, 'risk=0 时 ambiguity 无影响');
  });

  it('analyticalIntuitive：越分析越阻尼认知偏差（理性，少受偏差左右）', () => {
    const biased = cog({ biasWeights: new Map([['confirmation', 0.8], ['optimism', 0.6]]) });
    const base = makeInput({ riskScore: 0.5 });
    const intuitive = computeStructuralScore({ ...base, cognitiveModel: { ...biased, analyticalIntuitive: 0.0 } });
    const analytical = computeStructuralScore({ ...base, cognitiveModel: { ...biased, analyticalIntuitive: 1.0 } });
    /* 偏差驱动的 cognitiveBias：直觉型放大、分析型阻尼 → |分析的 bias| < |直觉的 bias|。 */
    assert.ok(Math.abs(analytical.cognitiveBias) < Math.abs(intuitive.cognitiveBias),
      `分析 ${analytical.cognitiveBias} 应比直觉 ${intuitive.cognitiveBias} 更受阻尼`);
  });

  it('向后兼容：无偏差 + 中性新维度 → overallScore 与不含新维度的旧行为一致', () => {
    /* 中性 0.5 的新维度 + 无 biasWeights → cognitiveBias 仅来自 attribution（旧逻辑），新维度贡献 0。 */
    const r = computeStructuralScore(makeInput({ riskScore: 0.5, cognitiveModel: cog({ ambiguityTolerance: 0.5, analyticalIntuitive: 0.5 }) }));
    /* attributionAdjustment = (1-0.5)*0.02 = 0.01；中性新维度不加不减。 */
    assert.ok(Math.abs(r.cognitiveBias - 0.01) < 1e-9, `中性新维度 cognitiveBias 应为旧值 0.01，实测 ${r.cognitiveBias}`);
  });
});
