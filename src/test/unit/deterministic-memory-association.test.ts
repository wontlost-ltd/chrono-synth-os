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
  MIN_EDGE_STRENGTH as ASSOC_BUILD_MIN,
  type MemoryEdgeStore,
} from '../../conversation/deterministic-memory-association.js';
import {
  CO_OCCURRENCE_RELATION,
  CO_OCCURRENCE_TRAVERSE_MIN,
} from '../../conversation/deterministic-memory-retrieval.js';

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

  it('共享 <3 关键词不连（避免噪声边——收紧防 Java 误连 Rust）', () => {
    const edges = computeAssociativeEdges('new', 'Java 并发 线程 同步 锁', [
      { id: 'a', content: 'Python 数据 分析 Java 可视化' },       // 只共享 Java(1) → 不连
      { id: 'b', content: 'Rust 所有权 线程 同步 借用检查' },     // 共享 线程/同步(2) < 3 → 不连（正是用户遇到的 Java→Rust 误联想）
    ]);
    assert.equal(edges.length, 0, '共享 2 个泛词不足以连边');
  });

  /* 真实句回归（用户实际输入）：验证重叠系数度量对「真·相关 vs 假·相关」的分离，
   * 这是从 Jaccard 改 overlap 的直接动因——CJK n-gram 下 Jaccard 会把真相关句稀释到连不上。 */
  it('真实句【应连】：杭州旅游 ↔ 杭州美食（重叠系数 0.185 > 0.15）', () => {
    const edges = computeAssociativeEdges('new', '杭州西湖边的美食有小笼包和龙井虾仁', [
      { id: 'trip', content: '上周我去杭州西湖旅游玩得很开心' },
    ]);
    assert.equal(edges.length, 1, '共享杭州/西湖等概念应连边（Jaccard 0.094 会漏，overlap 0.185 连上）');
    assert.equal(edges[0].targetId, 'trip');
  });

  it('真实句【不应连】：Java 线程 ↔ Rust 所有权（只共享「我在学」碎片，overlap 0.143 < 0.15）', () => {
    const edges = computeAssociativeEdges('new', '我在学 Rust，Rust 的所有权和借用检查器很难', [
      { id: 'java', content: '我在学 Java，Java 的线程生命周期很复杂' },
    ]);
    assert.equal(edges.length, 0, 'Java 记忆不应污染 Rust 联想（正是用户报告的误联想）');
  });

  /* 关键回归：**实际存储形态带「（来自对话）」前缀**。若不剥前缀，样板 token（来自/对话/…）会把
   * Java↔Rust overlap 从 0.143 虚抬到 0.308、误连——这正是用户端到端看到的 Java 污染 Rust。 */
  it('带来源前缀的实际存储形态：前缀不得制造虚假联想（Java↔Rust 仍不连）', () => {
    const edges = computeAssociativeEdges('new', '（来自对话）我在学 Rust，Rust 的所有权和借用检查器很难', [
      { id: 'java', content: '（来自对话）我在学 Java，Java 的线程生命周期很复杂' },
    ]);
    assert.equal(edges.length, 0, '「（来自对话）」样板前缀必须被剥除，不得虚抬 overlap 误连');
  });

  it('带来源前缀的实际存储形态：真·相关仍连（杭州旅游 ↔ 杭州美食）', () => {
    const edges = computeAssociativeEdges('new', '（来自对话）杭州西湖边的美食有小笼包和龙井虾仁', [
      { id: 'trip', content: '（来自对话）上周我去杭州西湖旅游玩得很开心' },
    ]);
    assert.equal(edges.length, 1, '剥前缀后杭州相关仍连边（不误伤真联想）');
    assert.equal(edges[0].targetId, 'trip');
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

describe('建边/检索一致性（防「建了但遍历不到」死区）', () => {
  it('联想边关系名两处一致', () => {
    assert.equal(ASSOCIATION_RELATION, CO_OCCURRENCE_RELATION,
      '建边 relation 必须 = 检索识别的 co_occurrence 关系名');
  });

  it('建边下限 = 检索遍历下限（否则 [下限,0.3) 的边建了却走不到）', () => {
    assert.equal(ASSOC_BUILD_MIN, CO_OCCURRENCE_TRAVERSE_MIN,
      '建边强度下限必须 = 检索侧共现边遍历门槛，避免死区联想静默失效');
  });
});
