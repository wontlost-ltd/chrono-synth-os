import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFamilyState, DEFAULT_FAMILY_CONFIG, type FamilySystemConfig } from '../../simulation/family-system-model.js';
import type { FamilyState } from '../../types/life-simulation.js';

const PREV: FamilyState = { spouseSecurity: 0.8, childCost: 0, familyPressure: 0.2 };

describe('computeFamilyState', () => {
  it('稳定收入维持高配偶安全感', () => {
    const result = computeFamilyState(PREV, {
      year: 1, wealth: 1000000, income: 300000, stress: 0.2, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    assert.ok(result.spouseSecurity > 0.5, `spouseSecurity=${result.spouseSecurity}`);
    assert.ok(result.familyPressure < 0.5, `familyPressure=${result.familyPressure}`);
  });

  it('连续低收入触发恐慌降低安全感', () => {
    const stable = computeFamilyState(PREV, {
      year: 1, wealth: 500000, income: 200000, stress: 0.3, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    const panic = computeFamilyState(PREV, {
      year: 1, wealth: 500000, income: 200000, stress: 0.3, lowIncomeYears: 3,
    }, DEFAULT_FAMILY_CONFIG);
    assert.ok(panic.spouseSecurity < stable.spouseSecurity,
      `panic=${panic.spouseSecurity} should < stable=${stable.spouseSecurity}`);
  });

  it('子女成本按教育曲线递增', () => {
    const y1 = computeFamilyState(PREV, {
      year: 1, wealth: 500000, income: 200000, stress: 0.3, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    const y5 = computeFamilyState(PREV, {
      year: 5, wealth: 500000, income: 200000, stress: 0.3, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    assert.ok(y5.childCost >= y1.childCost, `y5=${y5.childCost} should >= y1=${y1.childCost}`);
  });

  it('高压力增加家庭压力', () => {
    const low = computeFamilyState(PREV, {
      year: 1, wealth: 500000, income: 200000, stress: 0.1, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    const high = computeFamilyState(PREV, {
      year: 1, wealth: 500000, income: 200000, stress: 0.9, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    assert.ok(high.familyPressure > low.familyPressure,
      `high=${high.familyPressure} should > low=${low.familyPressure}`);
  });

  it('所有输出值在 [0,1] 范围内', () => {
    const result = computeFamilyState(PREV, {
      year: 10, wealth: 0, income: 0, stress: 1, lowIncomeYears: 5,
    }, DEFAULT_FAMILY_CONFIG);
    assert.ok(result.spouseSecurity >= 0 && result.spouseSecurity <= 1);
    assert.ok(result.familyPressure >= 0 && result.familyPressure <= 1);
    assert.ok(result.childCost >= 0);
  });

  it('自定义配置覆盖默认值', () => {
    const config: FamilySystemConfig = {
      ...DEFAULT_FAMILY_CONFIG,
      familyPressureCoefficient: 0.1,
    };
    const result = computeFamilyState(PREV, {
      year: 1, wealth: 100000, income: 50000, stress: 0.5, lowIncomeYears: 0,
    }, config);
    assert.ok(result.familyPressure < 0.5, `low coefficient should reduce pressure: ${result.familyPressure}`);
  });

  it('超出教育曲线长度取最后一个值', () => {
    const result = computeFamilyState(PREV, {
      year: 50, wealth: 500000, income: 200000, stress: 0.3, lowIncomeYears: 0,
    }, DEFAULT_FAMILY_CONFIG);
    const lastCost = DEFAULT_FAMILY_CONFIG.childEducationCostCurve[DEFAULT_FAMILY_CONFIG.childEducationCostCurve.length - 1];
    assert.equal(result.childCost, lastCost);
  });
});
