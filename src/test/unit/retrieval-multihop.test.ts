/**
 * 多跳图遍历检索单测（②）—— 用 ① 的基准证明「多跳提升 recall」，不靠体感。
 *
 * 验证：
 *   1. maxHops=1 严格等价于改造前的单跳行为（向后兼容，不破坏 ①）；
 *   2. 多跳串联让仅经 2 跳可达的语义记忆被召回（深度技术问答场景）；
 *   3. 用 compareRetrievalBenchmarks 量化 1跳 vs 2跳 的 recall delta（>0 = 多跳确实更全）；
 *   4. 确定性：多跳 BFS 相同输入相同输出，与边返回顺序无关；多路径取**全局最优** relevance（max-product 松弛）；
 *   5. 安全收敛：成环不死循环（maxHops 硬上界 + 仅推进被改善节点）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryNode, MemoryEdge, MemoryId } from '@chrono/kernel';
import {
  runRetrievalBenchmark,
  compareRetrievalBenchmarks,
  buildEdgeLookup,
  type RetrievalCase,
  type RetrievalDataset,
} from '../../conversation/retrieval-benchmark.js';
import {
  retrieveMemoriesDeterministic,
  DEFAULT_RETRIEVAL_PARAMS,
  type RetrievalParams,
  type EdgeLookup,
} from '../../conversation/deterministic-memory-retrieval.js';

function mem(id: string, content: string): MemoryNode {
  return {
    id, kind: 'semantic', content, valence: 0, salience: 0.5,
    createdAt: 0, lastAccessedAt: 0, accessCount: 0, decayLambda: 0, lastDecayedAt: 0, consolidatedFrom: null,
  };
}
function edge(source: string, target: string, strength: number, relation = 'related'): MemoryEdge {
  return { source, target, strength, relation };
}
function dataset(nodes: MemoryNode[], edges: MemoryEdge[]): RetrievalDataset {
  return { memories: new Map<MemoryId, MemoryNode>(nodes.map((n) => [n.id, n])), edges };
}
function withHops(maxHops: number): RetrievalParams {
  return { ...DEFAULT_RETRIEVAL_PARAMS, maxHops };
}

/* 2 跳链：query「虚拟线程」直接命中 m_vt → (1跳) m_carrier → (2跳) m_unmount。
 * 关键：m_carrier / m_unmount 都**不含**「虚拟」「线程」等查询词（否则会变成直接命中而非图遍历邻居），
 * 只有沿语义边才可达——这样才隔离地验证「1 跳 vs 2 跳」的图遍历行为与衰减排序。 */
const CHAIN_NODES: MemoryNode[] = [
  mem('m_vt', 'Java 21 虚拟线程由 JVM 调度，M:N 映射到平台载体。'),
  mem('m_carrier', '承载体在阻塞时负责挂起与恢复，是底层调度单元。'),
  mem('m_unmount', '阻塞时会从承载体上卸载，释放底层资源给其它任务。'),
  mem('m_noise', '今天天气不错，适合散步。'),
];
const CHAIN_EDGES: MemoryEdge[] = [
  edge('m_vt', 'm_carrier', 0.9),       /* 1 跳 */
  edge('m_carrier', 'm_unmount', 0.85), /* 2 跳（从 m_vt 看） */
];

describe('多跳图遍历检索（②）', () => {
  it('maxHops=1 等价于单跳：仅拉 1 跳邻居，2 跳节点不进', () => {
    const ds = dataset(CHAIN_NODES, CHAIN_EDGES);
    const ids = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(1)).map((r) => r.id);
    assert.ok(ids.includes('m_vt'), '直接命中');
    assert.ok(ids.includes('m_carrier'), '1 跳邻居');
    assert.ok(!ids.includes('m_unmount'), '2 跳节点在 1 跳模式下不应进');
  });

  it('maxHops=2 串联：仅 2 跳可达的语义记忆被召回', () => {
    const ds = dataset(CHAIN_NODES, CHAIN_EDGES);
    const ids = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(2)).map((r) => r.id);
    assert.ok(ids.includes('m_unmount'), '2 跳串联召回（m_vt→m_carrier→m_unmount）');
    assert.ok(!ids.includes('m_noise'), '无边的无关记忆仍不进');
  });

  it('基准量化：2 跳的 recall delta > 0（数字说话，不靠体感）', () => {
    const ds = dataset(CHAIN_NODES, CHAIN_EDGES);
    const cases: RetrievalCase[] = [
      { id: 'q_vt_deep', query: '虚拟线程', expectedMemoryIds: ['m_vt', 'm_carrier', 'm_unmount'] },
    ];
    const oneHop = runRetrievalBenchmark(ds, cases, 5, withHops(1));
    const twoHop = runRetrievalBenchmark(ds, cases, 5, withHops(2));
    const cmp = compareRetrievalBenchmarks(oneHop, twoHop);
    assert.ok(cmp.recallDelta > 0, `2 跳应提升 recall，实测 delta=${cmp.recallDelta}`);
    assert.equal(twoHop.meanRecall, 1, '2 跳全召回链上 3 条');
    assert.ok(oneHop.meanRecall < 1, '1 跳漏掉 2 跳节点');
  });

  it('深跳衰减：2 跳节点 relevance 严格低于 1 跳节点（排序在后）', () => {
    const ds = dataset(CHAIN_NODES, CHAIN_EDGES);
    const res = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(2));
    const carrier = res.find((r) => r.id === 'm_carrier')!;
    const unmount = res.find((r) => r.id === 'm_unmount')!;
    assert.ok(unmount.relevance < carrier.relevance, '复合衰减：2 跳 < 1 跳');
    /* 直接命中 m_vt 应在最前。 */
    assert.equal(res[0].id, 'm_vt', '直接命中排最前');
  });

  it('确定性：多跳 BFS 与边返回顺序无关（乱序取边器 → 相同结果）', () => {
    const ds = dataset(CHAIN_NODES, CHAIN_EDGES);
    const normal = buildEdgeLookup(ds.edges);
    /* 反序取边器：把每个节点的边列表反转，模拟不同 Map/SQL 返回顺序。 */
    const reversed: EdgeLookup = (id) => [...normal(id)].reverse();
    const a = retrieveMemoriesDeterministic('虚拟线程', ds.memories, normal, withHops(2));
    const b = retrieveMemoriesDeterministic('虚拟线程', ds.memories, reversed, withHops(2));
    assert.deepEqual(a, b, '边顺序不影响结果（确定性）');
  });

  it('多路径取最优 relevance：经强路径到达的分数胜过弱路径（与到达顺序无关）', () => {
    /* m_target 经两条路径可达：m_vt→m_target（强 0.9）与 m_vt→m_weak→m_target（弱 0.4×0.4）。
     * 强路径 1 跳应胜出（取 max），结果与边遍历顺序无关。 */
    const nodes = [
      mem('m_vt', '虚拟线程的核心机制。'),
      mem('m_weak', '一个弱相关的中间记忆。'),
      mem('m_target', '目标记忆，被两条路径指向。'),
    ];
    const edges = [
      edge('m_vt', 'm_target', 0.9),   /* 强 1 跳 */
      edge('m_vt', 'm_weak', 0.4),     /* 弱 1 跳 */
      edge('m_weak', 'm_target', 0.4), /* 弱 2 跳 */
    ];
    const ds = dataset(nodes, edges);
    const res = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(2));
    const target = res.find((r) => r.id === 'm_target')!;
    const vt = res.find((r) => r.id === 'm_vt')!;
    /* 强 1 跳 relevance = vt.relevance × 0.9 × decay；弱 2 跳更低。取 max → 等于强 1 跳值。 */
    const expectStrong = vt.relevance * 0.9 * DEFAULT_RETRIEVAL_PARAMS.neighborDecay;
    assert.ok(Math.abs(target.relevance - expectStrong) < 1e-9, '多路径取强路径分（max，与顺序无关）');
  });

  it('关键反例（Codex 复审）：弱 1 跳 vs 强 2 跳——强 2 跳路径必须胜出（全局 max，非浅跳锁定）', () => {
    /* m_target 经两条路径：m_vt→m_target（弱 0.31，刚过门槛）与 m_vt→m_hub→m_target（强 1.0×1.0）。
     * decay=0.8 时：弱 1 跳 = seed×0.31×0.8=seed×0.248；强 2 跳 = seed×1.0×0.8×1.0×0.8=seed×0.64。
     * 浅跳锁定（旧实现的 bug）会把 m_target 锁死在 0.248；正确的松弛应取 2 跳的 0.64。 */
    const nodes = [
      mem('m_vt', '虚拟线程的入口记忆。'),
      mem('m_hub', '一个强连接的枢纽记忆。'),
      mem('m_target', '真正最相关的目标，经强 2 跳可达。'),
    ];
    const edges = [
      edge('m_vt', 'm_target', 0.31), /* 弱 1 跳（刚过 minEdgeStrength=0.3） */
      edge('m_vt', 'm_hub', 1.0),     /* 强 1 跳 */
      edge('m_hub', 'm_target', 1.0), /* 强 2 跳 */
    ];
    const ds = dataset(nodes, edges);
    const res = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(2));
    const target = res.find((r) => r.id === 'm_target')!;
    const vt = res.find((r) => r.id === 'm_vt')!;
    const strongTwoHop = vt.relevance * 1.0 * DEFAULT_RETRIEVAL_PARAMS.neighborDecay * 1.0 * DEFAULT_RETRIEVAL_PARAMS.neighborDecay;
    assert.ok(
      Math.abs(target.relevance - strongTwoHop) < 1e-9,
      `强 2 跳应胜出（全局 max），期望 ${strongTwoHop} 实测 ${target.relevance}`,
    );
    /* 顺序无关：反序取边器同样得到强 2 跳分。 */
    const reversed: EdgeLookup = (id) => [...buildEdgeLookup(ds.edges)(id)].reverse();
    const res2 = retrieveMemoriesDeterministic('虚拟线程', ds.memories, reversed, withHops(2));
    assert.equal(res2.find((r) => r.id === 'm_target')!.relevance, target.relevance, '松弛结果与边顺序无关');
  });

  it('直接命中是下界：关键词命中的记忆永不被图遍历邻居分覆盖', () => {
    /* m_both 既被关键词直接命中（含「虚拟线程」），又是 m_vt 的邻居。直接命中分应保留，不被邻居分降级。 */
    const nodes = [
      mem('m_vt', '虚拟线程入口。'),
      mem('m_both', '虚拟线程的另一段直接相关描述。'),
    ];
    const edges = [edge('m_vt', 'm_both', 0.9)];
    const ds = dataset(nodes, edges);
    const res = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(2));
    const both = res.find((r) => r.id === 'm_both')!;
    /* m_both 直接命中分 = score/(score+4) > 任何邻居衰减分；它应以直接命中身份出现（relevance 较高）。 */
    assert.ok(both.relevance > 0.3, '直接命中分保留，未被邻居衰减分覆盖');
  });

  it('成环不死循环：A↔B↔C 环 + 多跳 → 收敛、每节点最多收录一次', () => {
    const nodes = [mem('m_a', '虚拟线程 A'), mem('m_b', '节点 B'), mem('m_c', '节点 C')];
    const edges = [edge('m_a', 'm_b', 0.9), edge('m_b', 'm_c', 0.9), edge('m_c', 'm_a', 0.9)];
    const ds = dataset(nodes, edges);
    /* maxHops 给大值（5）压力测试收敛——maxHops 硬上界 + 每波仅推进被改善节点保证不死循环、不重复。 */
    const res = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges), withHops(5));
    const ids = res.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, '无重复节点（环已收敛）');
    assert.ok(ids.includes('m_a') && ids.includes('m_b') && ids.includes('m_c'), '环上节点都召回一次');
  });
});
