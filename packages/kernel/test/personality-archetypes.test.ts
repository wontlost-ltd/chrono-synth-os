/**
 * 性格原型目录（② 经典 4 象限）：4 原型种子合法、互相拉开、可叠加扰动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  archetypeDecisionStyle,
  isPersonalityArchetype,
  PERSONALITY_ARCHETYPES,
} from '../src/domain/core-self/personality-archetypes.js';
import { validateDecisionStyle } from '../src/domain/core-self/decision-style-service.js';
import { perturbDecisionStyle } from '../src/domain/core-self/decision-style-perturbation.js';
import { personalityDiversity } from '../src/domain/core-self/personality-diversity.js';

describe('性格原型目录（②）', () => {
  it('4 原型种子都合法（过 validateDecisionStyle）', () => {
    for (const a of PERSONALITY_ARCHETYPES) {
      const s = archetypeDecisionStyle(a, 1000);
      assert.doesNotThrow(() => validateDecisionStyle(s), `原型 ${a} 应合法`);
      assert.equal(s.updatedAt, 1000, 'updatedAt 写入');
    }
  });

  it('4 原型在性格空间里互相拉开（用①度量 diversityScore 显著 > 0）', () => {
    const styles = PERSONALITY_ARCHETYPES.map((a) => archetypeDecisionStyle(a, 0));
    const div = personalityDiversity(styles);
    /* 4 个刻意拉开的原型应有明显多样性（远大于扰动级别）。 */
    assert.ok(div.diversityScore > 0.2, `4 原型应明显分散，实测 ${div.diversityScore}`);
  });

  it('原型语义符合设计：explorer 高探索/守护者高损失厌恶/分析师最深思/行动者最短期', () => {
    const explorer = archetypeDecisionStyle('explorer', 0);
    const guardian = archetypeDecisionStyle('guardian', 0);
    const analyst = archetypeDecisionStyle('analyst', 0);
    const doer = archetypeDecisionStyle('doer', 0);
    assert.ok(explorer.explorationBias > guardian.explorationBias, 'explorer 比 guardian 更探索');
    assert.ok(guardian.lossAversion > explorer.lossAversion, 'guardian 更损失厌恶');
    assert.equal(analyst.deliberationDepth, 5, 'analyst 最深思');
    assert.ok(doer.timeHorizon < analyst.timeHorizon, 'doer 比 analyst 更短期');
    assert.equal(doer.deliberationDepth, 1, 'doer 最浅思（最快）');
  });

  it('原型 + ③扰动叠加：同原型也有个体差异（但仍合法）', () => {
    /* 同 explorer 原型 + 不同 seed 扰动 → 个体不同，仍过 validate。 */
    const a = perturbDecisionStyle(archetypeDecisionStyle('explorer', 0), 'persona_1', 0.2, 1000);
    const b = perturbDecisionStyle(archetypeDecisionStyle('explorer', 0), 'persona_2', 0.2, 1000);
    assert.doesNotThrow(() => validateDecisionStyle(a));
    assert.doesNotThrow(() => validateDecisionStyle(b));
    assert.notDeepEqual(
      [a.riskAppetite, a.explorationBias, a.timeHorizon],
      [b.riskAppetite, b.explorationBias, b.timeHorizon],
      '同原型不同个体应有差异',
    );
  });

  it('isPersonalityArchetype 校验：合法原型 true，脏值 false', () => {
    assert.equal(isPersonalityArchetype('explorer'), true);
    assert.equal(isPersonalityArchetype('guardian'), true);
    assert.equal(isPersonalityArchetype('bogus'), false);
    assert.equal(isPersonalityArchetype(null), false);
    assert.equal(isPersonalityArchetype(42), false);
  });

  it('未知原型 → 抛错（不出生无定义性格）', () => {
    assert.throws(() => archetypeDecisionStyle('nope' as never, 0), /未知性格原型/);
  });
});
