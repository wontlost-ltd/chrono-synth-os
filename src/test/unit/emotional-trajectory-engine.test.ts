import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextEmotionalState, DEFAULT_EMOTIONAL_CONFIG } from '../../simulation/emotional-trajectory-engine.js';
import type { EmotionalState, FinanceState, FamilyState } from '../../types/life-simulation.js';

const PREV: EmotionalState = { valence: 0.3, stress: 0.3, fulfillment: 0.5, regret: 0.1 };
const FINANCE: FinanceState = { income: 300000, savings: 500000, wealth: 500000 };
const FAMILY: FamilyState = { spouseSecurity: 0.8, childCost: 50000, familyPressure: 0.2 };

describe('nextEmotionalState', () => {
  it('高对齐度提升满足感', () => {
    const high = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.9,
    }, DEFAULT_EMOTIONAL_CONFIG);
    const low = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.2,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(high.fulfillment > low.fulfillment,
      `high=${high.fulfillment} should > low=${low.fulfillment}`);
  });

  it('高家庭压力增加综合压力', () => {
    const lowPressure = nextEmotionalState(PREV, {
      finance: FINANCE,
      family: { ...FAMILY, familyPressure: 0.1 },
      healthIndex: 0.9, year: 1, valueAlignment: 0.5,
    }, DEFAULT_EMOTIONAL_CONFIG);
    const highPressure = nextEmotionalState(PREV, {
      finance: FINANCE,
      family: { ...FAMILY, familyPressure: 0.9 },
      healthIndex: 0.9, year: 1, valueAlignment: 0.5,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(highPressure.stress > lowPressure.stress,
      `high=${highPressure.stress} should > low=${lowPressure.stress}`);
  });

  it('低对齐度累积后悔', () => {
    const result = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.1,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(result.regret > PREV.regret, `regret=${result.regret} should > prev=${PREV.regret}`);
  });

  it('高对齐度不增加后悔', () => {
    const result = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.9,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(result.regret <= PREV.regret + 0.01, `regret=${result.regret} should not increase much`);
  });

  it('零收入产生高财务压力', () => {
    const result = nextEmotionalState(PREV, {
      finance: { income: 0, savings: 0, wealth: 0 },
      family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.5,
    }, DEFAULT_EMOTIONAL_CONFIG);
    /* 综合压力 = familyPressure(0.2)*0.35 + financialStress(0.9)*0.35 + healthStress(0.1)*0.3 ≈ 0.415 */
    assert.ok(result.stress > 0.35, `stress=${result.stress} should be elevated with zero income`);
    /* 对比正常收入场景，零收入压力应明显更高 */
    const normal = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.5,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(result.stress > normal.stress,
      `zeroIncome stress=${result.stress} should > normal=${normal.stress}`);
  });

  it('所有输出值在有效范围内', () => {
    const result = nextEmotionalState(PREV, {
      finance: { income: 0, savings: -100000, wealth: 0 },
      family: { spouseSecurity: 0, childCost: 100000, familyPressure: 1 },
      healthIndex: 0.1, year: 10, valueAlignment: 0,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(result.valence >= -1 && result.valence <= 1, `valence=${result.valence}`);
    assert.ok(result.stress >= 0 && result.stress <= 1, `stress=${result.stress}`);
    assert.ok(result.fulfillment >= 0 && result.fulfillment <= 1, `fulfillment=${result.fulfillment}`);
    assert.ok(result.regret >= 0 && result.regret <= 1, `regret=${result.regret}`);
  });

  it('满足感惯性保持上一年部分值', () => {
    const highPrev: EmotionalState = { ...PREV, fulfillment: 0.9 };
    const result = nextEmotionalState(highPrev, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.9, year: 1, valueAlignment: 0.3,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(result.fulfillment > 0.5,
      `fulfillment=${result.fulfillment} should retain inertia from 0.9`);
  });

  it('健康差增加压力', () => {
    const healthy = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.95, year: 1, valueAlignment: 0.5,
    }, DEFAULT_EMOTIONAL_CONFIG);
    const unhealthy = nextEmotionalState(PREV, {
      finance: FINANCE, family: FAMILY, healthIndex: 0.3, year: 1, valueAlignment: 0.5,
    }, DEFAULT_EMOTIONAL_CONFIG);
    assert.ok(unhealthy.stress > healthy.stress,
      `unhealthy=${unhealthy.stress} should > healthy=${healthy.stress}`);
  });
});
