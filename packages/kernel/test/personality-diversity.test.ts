/**
 * 性格多样性度量（①）：6 维 decision style 归一化 + 平均成对距离 + 每维 spread。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  personalityDiversity,
  normalizePersonality,
} from '../src/domain/core-self/personality-diversity.js';
import type { DecisionStyle } from '../src/domain/core-self/decision-style-types.js';

/** 构造一个 DecisionStyle（默认中庸；覆盖部分维度造差异）。 */
function style(o?: Partial<DecisionStyle>): DecisionStyle {
  return {
    riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.3,
    lossAversion: 2.0, deliberationDepth: 3, regretSensitivity: 0.5,
    updatedAt: 0, ...o,
  };
}

describe('性格多样性度量（①）', () => {
  it('归一化：5 个 [0,1] 维直通；deliberationDepth (d-1)/4；lossAversion 饱和', () => {
    const v = normalizePersonality(style({ riskAppetite: 0.7, deliberationDepth: 5, lossAversion: 2.0 }));
    assert.equal(v.riskAppetite, 0.7, '0-1 维直通');
    assert.equal(v.deliberationDepth, 1, 'depth 5 → (5-1)/4 = 1');
    assert.equal(normalizePersonality(style({ deliberationDepth: 1 })).deliberationDepth, 0, 'depth 1 → 0');
    assert.equal(normalizePersonality(style({ deliberationDepth: 3 })).deliberationDepth, 0.5, 'depth 3 → 0.5');
    /* lossAversion 2.0 → (2-1)/((2-1)+1) = 0.5；la=1 → 0；la=3 → 0.667。 */
    assert.equal(v.lossAversion, 0.5, 'la 2.0 → 0.5');
    assert.equal(normalizePersonality(style({ lossAversion: 1 })).lossAversion, 0, 'la 1 → 0');
    assert.ok(Math.abs(normalizePersonality(style({ lossAversion: 3 })).lossAversion - 2 / 3) < 1e-9, 'la 3 → 0.667');
  });

  it('全同 → 多样性分 0', () => {
    const r = personalityDiversity([style(), style(), style()]);
    assert.equal(r.count, 3);
    assert.equal(r.diversityScore, 0, '完全相同 → 0');
    /* 每维 spread 也应为 0。 */
    assert.equal(r.perDimensionSpread.riskAppetite, 0);
  });

  it('单元素 / 空 → 多样性分 0（无成对可比）', () => {
    assert.equal(personalityDiversity([style()]).diversityScore, 0);
    assert.equal(personalityDiversity([]).diversityScore, 0);
    assert.equal(personalityDiversity([]).count, 0);
  });

  it('两个极端对立 → 多样性分接近 1', () => {
    /* 全 0 向量 vs 全 1 向量：归一化后欧氏距离 = sqrt(6) = MAX → 分 = 1。 */
    const minStyle = style({ riskAppetite: 0, timeHorizon: 0, explorationBias: 0, regretSensitivity: 0, deliberationDepth: 1, lossAversion: 1 });
    const maxStyle = style({ riskAppetite: 1, timeHorizon: 1, explorationBias: 1, regretSensitivity: 1, deliberationDepth: 5, lossAversion: 1e9 });
    const r = personalityDiversity([minStyle, maxStyle]);
    assert.ok(r.diversityScore > 0.99, `极端对立应接近 1，实测 ${r.diversityScore}`);
  });

  it('各维等权：只在一个维度差 1 个满量程 → 距离 = 1/sqrt(6)', () => {
    /* 仅 riskAppetite 差 0→1，其余相同 → 成对距离 = 1，多样性分 = 1/sqrt(6) ≈ 0.408。 */
    const a = style({ riskAppetite: 0 });
    const b = style({ riskAppetite: 1 });
    const r = personalityDiversity([a, b]);
    assert.ok(Math.abs(r.diversityScore - 1 / Math.sqrt(6)) < 1e-9, `单维满量程差，实测 ${r.diversityScore}`);
  });

  it('per-dimension spread 指出驱动多样性的维度', () => {
    /* 只有 explorationBias 在样本间分散（0 vs 1），其余维度全同 → 该维 spread 最大，其余 0。 */
    const r = personalityDiversity([style({ explorationBias: 0 }), style({ explorationBias: 1 })]);
    assert.ok(r.perDimensionSpread.explorationBias > 0, 'explorationBias 有 spread');
    assert.equal(r.perDimensionSpread.riskAppetite, 0, '其余维度 spread 0');
    /* spread = 两点 {0,1} 的总体标准差 = 0.5。 */
    assert.ok(Math.abs(r.perDimensionSpread.explorationBias - 0.5) < 1e-9);
  });

  it('per-dimension mean 给群体性格画像', () => {
    const r = personalityDiversity([style({ riskAppetite: 0.2 }), style({ riskAppetite: 0.8 })]);
    assert.ok(Math.abs(r.perDimensionMean.riskAppetite - 0.5) < 1e-9, 'riskAppetite 均值 0.5');
  });

  it('确定性：相同输入相同输出，且与顺序无关', () => {
    const a = style({ riskAppetite: 0.2, deliberationDepth: 2 });
    const b = style({ riskAppetite: 0.9, explorationBias: 0.7 });
    const c = style({ lossAversion: 5, timeHorizon: 0.1 });
    const r1 = personalityDiversity([a, b, c]);
    const r2 = personalityDiversity([c, a, b]);
    assert.equal(r1.diversityScore, r2.diversityScore, '成对距离均值与顺序无关');
    assert.deepEqual(r1.perDimensionMean, r2.perDimensionMean);
  });

  it('脏数据兜底：越界/NaN/Infinity 被压住（不崩、不产 NaN，含 lossAversion）', () => {
    /* riskAppetite 2（越界）→ clamp 到 1；NaN → 0；lossAversion NaN/Infinity → 0（Codex 复审）。 */
    const dirty = [
      style({ riskAppetite: 2 }),
      style({ riskAppetite: Number.NaN }),
      style({ lossAversion: Number.NaN }),
      style({ lossAversion: Number.POSITIVE_INFINITY }),
      style({ deliberationDepth: Number.NaN }),
    ];
    const r = personalityDiversity(dirty);
    assert.ok(Number.isFinite(r.diversityScore), 'diversityScore 不产 NaN');
    assert.ok(r.diversityScore >= 0 && r.diversityScore <= 1, '分仍在 [0,1]');
    /* 每维 mean/spread 也都有限。 */
    for (const v of [r.perDimensionMean, r.perDimensionSpread]) {
      for (const k of Object.keys(v) as Array<keyof typeof v>) {
        assert.ok(Number.isFinite(v[k]), `${k} 有限`);
      }
    }
    /* lossAversion NaN/Infinity 单独验证归一化为 0。 */
    assert.equal(normalizePersonality(style({ lossAversion: Number.NaN })).lossAversion, 0);
    assert.equal(normalizePersonality(style({ lossAversion: Number.POSITIVE_INFINITY })).lossAversion, 0);
  });
});
