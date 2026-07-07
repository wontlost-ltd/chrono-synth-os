/**
 * 单元测试：确定性记忆联想建边（融会贯通地基）。
 * 验证共享关键词→连边、阈值过滤、top-K、确定性排序、排除自身。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAssociativeEdges,
  linkMemoryAssociatively,
  ASSOCIATION_RELATION,
  type MemoryEdgeStore,
} from '../../conversation/deterministic-memory-association.js';

describe('computeAssociativeEdges（确定性联想建边）', () => {
  it('共享足够关键词 → 连边；无关记忆不连', () => {
    const edges = computeAssociativeEdges('new', 'Java 并发 互斥锁 线程 同步', [
      { id: 'a', content: 'Java 线程 同步 volatile 可见性' },   // 共享 Java/线程/同步 → 连
      { id: 'b', content: '今天天气很好 我去公园散步了' },        // 无共享 → 不连
    ]);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].targetId, 'a');
    assert.ok(edges[0].strength > 0, '有强度');
  });

  it('排除自身（newId 不与自己连边）', () => {
    const edges = computeAssociativeEdges('self', 'Java 并发 线程 同步', [
      { id: 'self', content: 'Java 并发 线程 同步' },
    ]);
    assert.equal(edges.length, 0);
  });

  it('共享 <2 关键词不连（避免噪声边）', () => {
    const edges = computeAssociativeEdges('new', 'Java 并发 线程 同步 锁', [
      { id: 'a', content: 'Python 数据 分析 Java 可视化' }, // 只共享 Java(1) → 不连
    ]);
    assert.equal(edges.length, 0);
  });

  it('确定性：相同输入相同输出；强度降序 + id 二级键', () => {
    const existing = [
      { id: 'z', content: 'Java 并发 线程 同步 锁 volatile' },
      { id: 'a', content: 'Java 并发 线程 同步 锁 volatile' }, // 与 z 同内容 → 同强度，id 'a'<'z' 排前
    ];
    const e1 = computeAssociativeEdges('new', 'Java 并发 线程 同步 锁 volatile', existing);
    const e2 = computeAssociativeEdges('new', 'Java 并发 线程 同步 锁 volatile', existing);
    assert.deepEqual(e1, e2, '可复现');
    assert.equal(e1[0].targetId, 'a', '同强度按 id 字典序，a 在前');
  });

  it('top-K 上限 5（防泛词记忆与全库连边）', () => {
    const existing = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, content: 'Java 并发 线程 同步 锁',
    }));
    const edges = computeAssociativeEdges('new', 'Java 并发 线程 同步 锁', existing);
    assert.equal(edges.length, 5);
  });
});

describe('linkMemoryAssociatively（连边到 store）', () => {
  it('对每条计算出的边调 addEdge（relation=co_occurrence）', () => {
    const added: Array<{ s: string; t: string; rel: string }> = [];
    const store: MemoryEdgeStore = {
      getAllMemories: () => new Map([
        ['a', { id: 'a', content: 'Java 线程 同步 锁' }],
        ['new', { id: 'new', content: 'Java 线程 同步 锁 并发' }],
      ]),
      addEdge: (s, t, rel) => { added.push({ s, t, rel }); return null; },
    };
    const n = linkMemoryAssociatively(store, 'new', 'Java 线程 同步 锁 并发');
    assert.equal(n, 1);
    assert.deepEqual(added, [{ s: 'new', t: 'a', rel: ASSOCIATION_RELATION }]);
  });
});
