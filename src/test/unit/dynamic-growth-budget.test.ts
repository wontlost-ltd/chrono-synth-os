import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDynamicGrowthBudget,
  growthAggressivenessFromDecisionStyle,
  paramsForAggressiveness,
  NEUTRAL_AGGRESSIVENESS,
  DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS as P,
} from '../../intelligence/dynamic-growth-budget.js';

/* ADR-0048 动态成长预算 U 形公式——确定性、可复现。 */
describe('computeDynamicGrowthBudget', () => {
  it('全新白纸 M=0 → floor（保底能学，不为 0）', () => {
    assert.equal(computeDynamicGrowthBudget(0), P.floor);
  });

  it('婴儿期（M 小）→ 接近 M 的近翻倍（激进），但受 floor/ceil 夹', () => {
    /* M=10: openRatio=2.0×200/210≈1.905, round(10×1.905)=19，在 [3,30] 内。 */
    assert.equal(computeDynamicGrowthBudget(10), 19);
  });

  it('成长期（M 中）→ 封顶 ceil（绝对量大）', () => {
    /* M=100: round(100×1.333)=133 → ceil 30。 */
    assert.equal(computeDynamicGrowthBudget(100), P.ceil);
  });

  it('成熟期（M 大）→ 仍 ceil，但相对核心侵蚀比例极低', () => {
    const b = computeDynamicGrowthBudget(500);
    assert.equal(b, P.ceil, '绝对预算封顶');
    assert.ok(b / 500 < 0.1, `相对核心 ${(b / 500 * 100).toFixed(1)}% < 10%（成熟保守）`);
  });

  it('高度成熟（M 极大）→ 相对核心趋近 0（不被单日输入动摇）', () => {
    const b = computeDynamicGrowthBudget(2000);
    assert.equal(b, P.ceil);
    assert.ok(b / 2000 < 0.02, `相对核心 ${(b / 2000 * 100).toFixed(1)}% < 2%`);
  });

  it('单调性：相对核心侵蚀比例随 M 单调递减（U 形核心性质）', () => {
    const ratios = [10, 50, 100, 300, 800, 2000].map((m) => computeDynamicGrowthBudget(m) / m);
    for (let i = 1; i < ratios.length; i++) {
      assert.ok(ratios[i] <= ratios[i - 1], `M 增大相对比例应不增（${ratios[i - 1]}→${ratios[i]}）`);
    }
  });

  it('始终在 [floor, ceil] 内', () => {
    for (const m of [0, 1, 5, 50, 200, 1000, 100000]) {
      const b = computeDynamicGrowthBudget(m);
      assert.ok(b >= P.floor && b <= P.ceil, `M=${m} → ${b} 越界`);
    }
  });

  it('防御非有限/负数 → 视为 0 → floor（安全侧，不放开预算）', () => {
    assert.equal(computeDynamicGrowthBudget(-5), P.floor);
    assert.equal(computeDynamicGrowthBudget(NaN), P.floor);
    assert.equal(computeDynamicGrowthBudget(Infinity), P.floor, 'Infinity 非有限 → 视为 0 → floor（不误放开）');
  });

  it('确定性：相同 M → 相同预算', () => {
    assert.equal(computeDynamicGrowthBudget(137), computeDynamicGrowthBudget(137));
  });

  it('archetype 激进度可调（探索者 openRatioMax/ceil 高 → 预算更大）', () => {
    const explorer = { floor: 5, ceil: 50, openRatioMax: 3.0, halfMemories: 300 };
    const guardian = { floor: 2, ceil: 10, openRatioMax: 1.0, halfMemories: 100 };
    assert.ok(computeDynamicGrowthBudget(50, explorer) > computeDynamicGrowthBudget(50, guardian),
      '同 M 下探索者预算 > 守护者');
  });

  it('非法参数归一化（Codex 复审）：halfMemories≤0 / ceil<floor / 非有限 → 不产 NaN/异常', () => {
    for (const bad of [
      { floor: 3, ceil: 30, openRatioMax: 2.0, halfMemories: 0 },     // 除零风险
      { floor: 3, ceil: 30, openRatioMax: 2.0, halfMemories: -5 },    // 负衰减
      { floor: 30, ceil: 3, openRatioMax: 2.0, halfMemories: 200 },   // ceil<floor
      { floor: NaN, ceil: NaN, openRatioMax: NaN, halfMemories: NaN }, // 全非有限
    ]) {
      const b = computeDynamicGrowthBudget(100, bad);
      assert.ok(Number.isFinite(b) && b >= 0, `非法参数 ${JSON.stringify(bad)} → ${b} 应有限非负`);
    }
  });
});

/* ── 成长激进度按性格调制（从 decision style 派生）── */
describe('growthAggressivenessFromDecisionStyle', () => {
  it('explorer（爱探索+敢冒险）→ 高激进度', () => {
    const a = growthAggressivenessFromDecisionStyle({ explorationBias: 0.85, riskAppetite: 0.8 });
    assert.ok(a > 0.7, `explorer aggr ${a} 应高`);
  });
  it('guardian（规避损失，真实原型值 exp0.15/risk0.2）→ 低激进度', () => {
    const a = growthAggressivenessFromDecisionStyle({ explorationBias: 0.15, riskAppetite: 0.2 });
    assert.ok(a < 0.3, `guardian aggr ${a} 应低`);
  });
  it('中性 → ≈0.5', () => {
    const a = growthAggressivenessFromDecisionStyle({ explorationBias: 0.5, riskAppetite: 0.5 });
    assert.equal(a, 0.5);
  });
  it('越界值 clamp 到 [0,1]，NaN → 0.5', () => {
    assert.ok(growthAggressivenessFromDecisionStyle({ explorationBias: 5, riskAppetite: -3 }) >= 0);
    assert.equal(growthAggressivenessFromDecisionStyle({ explorationBias: NaN, riskAppetite: 0.5 }), 0.5);
  });
});

describe('paramsForAggressiveness + 端到端调制', () => {
  it('激进度只调曲线高低（openRatioMax/ceil），floor/halfMemories 不变', () => {
    const p = paramsForAggressiveness(0.8);
    assert.equal(p.floor, P.floor, 'floor 保底不变');
    assert.equal(p.halfMemories, P.halfMemories, '衰减半衰点不变');
    assert.ok(p.openRatioMax > P.openRatioMax * 0.5);
    assert.ok(p.ceil > 30, '激进 ceil 更高');
  });

  it('零回归（Codex 复审）：默认人格激进度(0.4)→DEFAULT params，与无 row 预算一致', () => {
    /* 默认 decision style exp0.3/risk0.5 → aggr=0.4=NEUTRAL_AGGRESSIVENESS → 恰好 DEFAULT_PARAMS。
     * 保证「有/无默认 decision_style row」的默认人格预算一致（既有 persona 不突变）。 */
    assert.equal(NEUTRAL_AGGRESSIVENESS, 0.4);
    const neutral = paramsForAggressiveness(NEUTRAL_AGGRESSIVENESS);
    assert.equal(neutral.openRatioMax, P.openRatioMax, '中性 openRatioMax = DEFAULT');
    assert.equal(neutral.ceil, P.ceil, '中性 ceil = DEFAULT');
    /* 端到端：默认人格各 M 下预算 = 无 row 默认预算。 */
    for (const M of [0, 10, 100, 500, 2000]) {
      assert.equal(
        computeDynamicGrowthBudget(M, neutral),
        computeDynamicGrowthBudget(M, P),
        `M=${M} 默认人格无突变`,
      );
    }
  });

  it('同成熟度下：explorer 预算 > 中性 > guardian（性格调激进度）', () => {
    const M = 100;
    const ea = growthAggressivenessFromDecisionStyle({ explorationBias: 0.85, riskAppetite: 0.8 });
    const ga = growthAggressivenessFromDecisionStyle({ explorationBias: 0.3, riskAppetite: 0.2 });
    const explorer = computeDynamicGrowthBudget(M, paramsForAggressiveness(ea));
    const neutral = computeDynamicGrowthBudget(M, paramsForAggressiveness(0.5));
    const guardian = computeDynamicGrowthBudget(M, paramsForAggressiveness(ga));
    assert.ok(explorer > neutral && neutral > guardian, `应 explorer(${explorer}) > 中性(${neutral}) > guardian(${guardian})`);
  });

  it('保留 U 形：同性格下相对核心侵蚀比例仍随 M 递减', () => {
    const p = paramsForAggressiveness(0.5);
    const ratios = [10, 100, 500, 2000].map((m) => computeDynamicGrowthBudget(m, p) / m);
    for (let i = 1; i < ratios.length; i++) assert.ok(ratios[i] <= ratios[i - 1]);
  });
});
