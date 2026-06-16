/**
 * 决策风格随机初始化（③ 出生机制）：可控、可复现扰动，结果合法、确定性，且能拉开多样性（用①验证）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { perturbDecisionStyle } from '../src/domain/core-self/decision-style-perturbation.js';
import { validateDecisionStyle } from '../src/domain/core-self/decision-style-service.js';
import { personalityDiversity } from '../src/domain/core-self/personality-diversity.js';
import type { DecisionStyle } from '../src/domain/core-self/decision-style-types.js';

const BASE: DecisionStyle = {
  riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.3,
  lossAversion: 2.0, deliberationDepth: 3, regretSensitivity: 0.5, updatedAt: 0,
};

describe('决策风格随机初始化（③）', () => {
  it('magnitude=0 → 不扰动（向后兼容，只更新时间戳）', () => {
    const r = perturbDecisionStyle(BASE, 'persona_1', 0, 1000);
    assert.equal(r.riskAppetite, BASE.riskAppetite);
    assert.equal(r.deliberationDepth, BASE.deliberationDepth);
    assert.equal(r.lossAversion, BASE.lossAversion);
    assert.equal(r.updatedAt, 1000, '仅更新时间戳');
  });

  it('确定性：同 seed → 同结果', () => {
    const a = perturbDecisionStyle(BASE, 'persona_1', 0.2, 1000);
    const b = perturbDecisionStyle(BASE, 'persona_1', 0.2, 1000);
    assert.deepEqual(a, b);
  });

  it('不同 seed → 不同结果（出生即不同）', () => {
    const a = perturbDecisionStyle(BASE, 'persona_1', 0.2, 1000);
    const b = perturbDecisionStyle(BASE, 'persona_2', 0.2, 1000);
    /* 至少一个维度不同（极小概率全同，用固定 seed 保证）。 */
    assert.notDeepEqual(
      { r: a.riskAppetite, t: a.timeHorizon, e: a.explorationBias },
      { r: b.riskAppetite, t: b.timeHorizon, e: b.explorationBias },
    );
  });

  it('扰动结果始终合法（过 validateDecisionStyle，不越界）', () => {
    /* 大幅度 + 多种子，全部应合法。 */
    for (let i = 0; i < 50; i++) {
      const r = perturbDecisionStyle(BASE, `persona_${i}`, 1.0, 1000);
      assert.doesNotThrow(() => validateDecisionStyle(r), `seed ${i} 应合法`);
      /* [0,1] 维在界内。 */
      assert.ok(r.riskAppetite >= 0 && r.riskAppetite <= 1);
      assert.ok(r.deliberationDepth >= 1 && r.deliberationDepth <= 5 && Number.isInteger(r.deliberationDepth));
      assert.ok(r.lossAversion >= 1, 'lossAversion 不向下越界');
    }
  });

  it('边界 base：极值附近扰动不越界（clamp 生效）', () => {
    const extreme: DecisionStyle = {
      riskAppetite: 1, timeHorizon: 0, explorationBias: 1, regretSensitivity: 0,
      lossAversion: 1, deliberationDepth: 5, updatedAt: 0,
    };
    const r = perturbDecisionStyle(extreme, 'x', 1.0, 1000);
    assert.doesNotThrow(() => validateDecisionStyle(r));
    assert.ok(r.riskAppetite <= 1 && r.regretSensitivity >= 0 && r.lossAversion >= 1 && r.deliberationDepth <= 5);
  });

  it('用①度量验证：扰动一批同源 persona → diversityScore > 0（真拉开多样性）', () => {
    /* 100 个同 base 但不同 seed 的 persona，扰动后应有可观测多样性。 */
    const batch: DecisionStyle[] = [];
    for (let i = 0; i < 100; i++) batch.push(perturbDecisionStyle(BASE, `p_${i}`, 0.3, 1000));
    const div = personalityDiversity(batch);
    assert.ok(div.diversityScore > 0, '扰动后有多样性');
    /* 对照：不扰动（magnitude=0）的同 base 批 → diversityScore=0。 */
    const same = Array.from({ length: 100 }, (_, i) => perturbDecisionStyle(BASE, `p_${i}`, 0, 1000));
    assert.equal(personalityDiversity(same).diversityScore, 0, '不扰动 → 0（对照证明扰动确实拉开了）');
  });

  it('magnitude 单调：更大幅度 → 更大多样性', () => {
    const mk = (mag: number) => personalityDiversity(
      Array.from({ length: 100 }, (_, i) => perturbDecisionStyle(BASE, `p_${i}`, mag, 1000)),
    ).diversityScore;
    assert.ok(mk(0.5) > mk(0.1), '幅度大多样性大');
  });
});
