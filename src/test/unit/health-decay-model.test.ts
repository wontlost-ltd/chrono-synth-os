import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextHealthIndex, DEFAULT_HEALTH_CONFIG } from '../../simulation/health-decay-model.js';

describe('nextHealthIndex', () => {
  it('低压力+年轻→健康维持高水平', () => {
    const result = nextHealthIndex(0.95, { age: 30, stress: 0.1, lifestyleScore: 0.8 }, DEFAULT_HEALTH_CONFIG);
    /* 年轻 + 低压力 + 好生活方式：恢复量可能略超衰减量 */
    assert.ok(result > 0.9, `health=${result} should stay high`);
    assert.ok(result <= 1.0, `health=${result} should not exceed 1`);
  });

  it('高压力加速健康衰减', () => {
    const low = nextHealthIndex(0.9, { age: 40, stress: 0.2, lifestyleScore: 0.5 }, DEFAULT_HEALTH_CONFIG);
    const high = nextHealthIndex(0.9, { age: 40, stress: 0.9, lifestyleScore: 0.5 }, DEFAULT_HEALTH_CONFIG);
    assert.ok(high < low, `highStress=${high} should < lowStress=${low}`);
  });

  it('年龄增大加速衰减', () => {
    const young = nextHealthIndex(0.9, { age: 30, stress: 0.5, lifestyleScore: 0.5 }, DEFAULT_HEALTH_CONFIG);
    const old = nextHealthIndex(0.9, { age: 60, stress: 0.5, lifestyleScore: 0.5 }, DEFAULT_HEALTH_CONFIG);
    assert.ok(old < young, `old=${old} should < young=${young}`);
  });

  it('结果始终在 [0,1] 范围内', () => {
    const extreme = nextHealthIndex(0.1, { age: 70, stress: 1, lifestyleScore: 0 }, DEFAULT_HEALTH_CONFIG);
    assert.ok(extreme >= 0 && extreme <= 1, `health=${extreme}`);

    const max = nextHealthIndex(1, { age: 20, stress: 0, lifestyleScore: 1 }, DEFAULT_HEALTH_CONFIG);
    assert.ok(max >= 0 && max <= 1, `health=${max}`);
  });

  it('低压力+好生活方式有恢复效果', () => {
    const withRecovery = nextHealthIndex(0.8, { age: 35, stress: 0, lifestyleScore: 1 }, DEFAULT_HEALTH_CONFIG);
    const withoutRecovery = nextHealthIndex(0.8, { age: 35, stress: 0, lifestyleScore: 0 }, DEFAULT_HEALTH_CONFIG);
    assert.ok(withRecovery >= withoutRecovery, `recovery=${withRecovery} should >= noRecovery=${withoutRecovery}`);
  });

  it('零压力不会使健康增加超过 1', () => {
    const result = nextHealthIndex(0.99, { age: 25, stress: 0, lifestyleScore: 1 }, DEFAULT_HEALTH_CONFIG);
    assert.ok(result <= 1, `health=${result} should not exceed 1`);
  });
});
