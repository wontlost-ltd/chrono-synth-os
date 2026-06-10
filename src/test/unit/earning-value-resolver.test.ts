/**
 * 单测：category → targetValue 解析（WP-0 earn→distill 闭环）。
 * 锁住映射策略：精确 id/label → 子串 → 最高权重兜底 → 无值 null。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetValueForCategory } from '../../intelligence/earning-value-resolver.js';

const values = [
  { id: 'curiosity', label: '好奇心', weight: 0.7 },
  { id: 'stability', label: '稳定', weight: 0.4 },
  { id: 'craft', label: '工艺', weight: 0.55 },
];

describe('resolveTargetValueForCategory', () => {
  it('精确匹配 id', () => {
    assert.deepEqual(resolveTargetValueForCategory('curiosity', values), { valueId: 'curiosity', currentWeight: 0.7 });
  });

  it('精确匹配 label（忽略大小写/空白）', () => {
    assert.deepEqual(resolveTargetValueForCategory(' 稳定 ', values), { valueId: 'stability', currentWeight: 0.4 });
  });

  it('子串匹配（category 含 value id）', () => {
    assert.equal(resolveTargetValueForCategory('craftsmanship', values)?.valueId, 'craft');
  });

  it('无明确映射 → null（不兜底强化最强价值，避免漂移）', () => {
    assert.equal(resolveTargetValueForCategory('totally-unrelated', values), null);
  });

  it('空 category → null', () => {
    assert.equal(resolveTargetValueForCategory('', values), null);
  });

  it('无 values → null', () => {
    assert.equal(resolveTargetValueForCategory('research', []), null);
  });
});
