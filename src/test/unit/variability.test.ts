import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { variantPick } from '../../conversation/variability.js';

/* ADR-0056 回应变化性——确定性：相同 (variants, seed) → 相同结果；seed=0 → 原文（零回归）。 */
describe('variantPick', () => {
  const bank = ['原文', '变体A', '变体B', '变体C'];

  it('seed=0/缺省 → 第 0 个（既有原文，零回归）', () => {
    assert.equal(variantPick(bank, 0), '原文');
  });

  it('按 seed mod 长度确定性轮换', () => {
    assert.equal(variantPick(bank, 1), '变体A');
    assert.equal(variantPick(bank, 2), '变体B');
    assert.equal(variantPick(bank, 3), '变体C');
    assert.equal(variantPick(bank, 4), '原文', '回到开头');
    assert.equal(variantPick(bank, 5), '变体A');
  });

  it('确定性：相同 seed 相同结果', () => {
    assert.equal(variantPick(bank, 7), variantPick(bank, 7));
  });

  it('负数/非整 seed 容错 → 取原文', () => {
    assert.equal(variantPick(bank, -3), '原文');
    assert.equal(variantPick(bank, Number.NaN), '原文');
  });

  it('大 seed 取整后取模', () => {
    assert.equal(variantPick(bank, 10.9), variantPick(bank, 10), '取整后一致');
    assert.equal(variantPick(bank, 10), '变体B', '10 mod 4 = 2');
  });

  it('空库 → 空串', () => {
    assert.equal(variantPick([], 3), '');
  });

  it('单元素库 → 恒取该元素（无论 seed）', () => {
    assert.equal(variantPick(['唯一'], 0), '唯一');
    assert.equal(variantPick(['唯一'], 5), '唯一');
  });
});
