import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeyPoints } from '../../collaboration/key-points.js';
import type { PerspectiveEvidence } from '../../collaboration/collaboration-types.js';

const ev = (excerpt: string): PerspectiveEvidence => ({ memoryId: 'm', excerpt, relevance: 0.5, association: false });

test('extractKeyPoints 只从 excerpt 提取内容词、去重、稳定排序', () => {
  const points = extractKeyPoints([ev('市场扩张 需要 更多 预算'), ev('预算 是 关键 约束')]);
  // 内容词进入（去停用词后），跨证据去重（预算只出现一次），稳定序（无 Date/random）
  assert.ok(points.includes('预算'));
  assert.ok(points.includes('市场扩张') || points.includes('市场'));
  assert.equal(points.filter((p) => p === '预算').length, 1);
  assert.deepEqual(points, [...points].sort()); // 稳定：按字典序
});

test('extractKeyPoints 空证据 → 空', () => {
  assert.deepEqual(extractKeyPoints([]), []);
});

test('extractKeyPoints 剥样板前缀（样板词的 n-gram 碎片不进 keyPoints）', () => {
  const points = extractKeyPoints([ev('据我记得 客户 重视 交付速度')]);
  // 剥掉「据我记得」前缀后，其 n-gram 碎片不应出现（若不剥会有「据我」「我记」「记得」等）
  assert.ok(!points.includes('据我') && !points.includes('我记') && !points.includes('记得'));
  assert.ok(!points.includes('据我记') && !points.includes('我记得'));
  assert.ok(points.includes('客户')); // 真实内容词仍在
});
