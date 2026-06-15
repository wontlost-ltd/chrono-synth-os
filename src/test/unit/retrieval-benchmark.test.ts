/**
 * 确定性检索质量基准单测（①）。
 *
 * 验证三件事：
 *   1. 基准对**生产同款检索逻辑**算出 precision/recall@k + MRR，且确定性可复现；
 *   2. fixture 完整性断言真生效（空 case / 期望 id 不存在 / 空期望集 → 抛错）；
 *   3. 调参对比（compareRetrievalBenchmarks）正确反映 recall 变化——这正是 ② 调参要依赖的尺子；
 *   4. 关键回归：图遍历让**同义不同词**的 query 经语义边命中（Java 21 那类场景），recall 因此更高。
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
} from '../../conversation/deterministic-memory-retrieval.js';

/** 构造最小合法 MemoryNode（仅检索关心 id/content；其余取确定性占位）。 */
function mem(id: string, content: string): MemoryNode {
  return {
    id,
    kind: 'semantic',
    content,
    valence: 0,
    salience: 0.5,
    createdAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    decayLambda: 0,
    lastDecayedAt: 0,
    consolidatedFrom: null,
  };
}

function edge(source: string, target: string, strength: number, relation = 'related'): MemoryEdge {
  return { source, target, strength, relation };
}

function dataset(nodes: MemoryNode[], edges: MemoryEdge[]): RetrievalDataset {
  const memories = new Map<MemoryId, MemoryNode>(nodes.map((n) => [n.id, n]));
  return { memories, edges };
}

/* —— Java 21 风格语义边场景：直接关键词命中「虚拟线程」，沿语义边拉出未直接命中的「轻量级并发」 —— */
const JAVA21_NODES: MemoryNode[] = [
  mem('m_vt', 'Java 21 虚拟线程由 JVM 调度，M:N 映射到平台线程（carrier thread）。'),
  mem('m_carrier', 'carrier thread 是承载虚拟线程的平台线程，阻塞时虚拟线程会卸载。'),
  mem('m_concurrency', '轻量级并发让百万级任务成为可能，无需为每任务绑定 OS 线程。'),
  mem('m_record', 'record pattern 在 switch 里解构记录类型，配合密封类做穷尽匹配。'),
  mem('m_noise', '今天天气不错，适合散步。'),
];
/* 边：虚拟线程 ↔ carrier（强），虚拟线程 ↔ 轻量级并发（强，跨词义）；与 record/noise 无边。 */
const JAVA21_EDGES: MemoryEdge[] = [
  edge('m_vt', 'm_carrier', 0.9),
  edge('m_vt', 'm_concurrency', 0.8),
];

describe('检索质量基准（①）', () => {
  it('对生产同款检索逻辑算 recall/precision/MRR，且确定性可复现', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    const cases: RetrievalCase[] = [
      { id: 'q_vt', query: '虚拟线程的原理是什么', expectedMemoryIds: ['m_vt', 'm_carrier'] },
      { id: 'q_record', query: 'record pattern 怎么用', expectedMemoryIds: ['m_record'] },
    ];
    const a = runRetrievalBenchmark(ds, cases);
    const b = runRetrievalBenchmark(ds, cases);
    /* 确定性：相同 dataset + 相同 case → 完全相同指标。 */
    assert.deepEqual(a, b);
    assert.ok(a.meanRecall > 0, '应有召回');
    assert.ok(a.mrr > 0, '应有命中排名');
    /* q_vt：'虚拟线程' 直接命中 m_vt，'carrier' 经词不一定直接命中，但 m_carrier 经强边拉入 → recall=1。 */
    const vt = a.cases.find((c) => c.caseId === 'q_vt')!;
    assert.equal(vt.recall, 1, 'm_vt 直接命中 + m_carrier 经图遍历拉入 → 全召回');
  });

  it('关键回归：图遍历让同义不同词经语义边命中（提升 recall）', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    /* query 只说「虚拟线程」，未提「轻量级并发」字样；期望经 m_vt→m_concurrency 强边把它拉进来。 */
    const retrieved = retrieveMemoriesDeterministic('虚拟线程', ds.memories, buildEdgeLookup(ds.edges)).map((r) => r.id);
    assert.ok(retrieved.includes('m_vt'), '直接命中');
    assert.ok(retrieved.includes('m_concurrency'), '同义不同词经语义边拉入（零模型语义检索）');
    assert.ok(!retrieved.includes('m_noise'), '无边的无关记忆不应被拉入');
  });

  it('调参对比：放宽边强度门槛改变 recall（compareRetrievalBenchmarks 反映变化）', () => {
    /* 一条弱边（0.4）连到 m_record；默认门槛 0.3 会拉入，调高到 0.5 则不拉入 → recall 下降。 */
    const nodes = [...JAVA21_NODES];
    const edges = [...JAVA21_EDGES, edge('m_vt', 'm_record', 0.4)];
    const ds = dataset(nodes, edges);
    const cases: RetrievalCase[] = [
      { id: 'q_vt_record', query: '虚拟线程', expectedMemoryIds: ['m_vt', 'm_record'] },
    ];
    const baseline = runRetrievalBenchmark(ds, cases); /* 默认门槛 0.3：弱边拉入 m_record */
    const strict = runRetrievalBenchmark(ds, cases, DEFAULT_RETRIEVAL_PARAMS.maxResults, {
      ...DEFAULT_RETRIEVAL_PARAMS,
      minEdgeStrength: 0.5, /* 调高门槛：0.4 弱边不再拉入 */
    });
    const cmp = compareRetrievalBenchmarks(baseline, strict);
    assert.ok(cmp.recallDelta < 0, '调高边门槛 → 弱边邻居丢失 → recall 下降（尺子正确反映）');
  });

  it('precision@k 分母为 k：少返回但都命中不虚高到 1.0（Codex 复审）', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    /* 'record' 只直接命中 m_record 一条、无边扩展 → 返回 1 条且命中；precision@5 应为 1/5=0.2，不是 1.0。 */
    const cases: RetrievalCase[] = [{ id: 'q_record', query: 'record pattern', expectedMemoryIds: ['m_record'] }];
    const m = runRetrievalBenchmark(ds, cases, 5);
    assert.equal(m.cases[0].retrieved.length, 1, '只返回 1 条');
    assert.equal(m.cases[0].recall, 1, '该条命中 → 全召回');
    assert.equal(m.cases[0].precision, 0.2, 'precision@5 = 1/5，不被「少返回」作弊抬高到 1.0');
  });

  it('固定 k 截断：candidate 调大 maxResults 不能作弊提升 recall（同深度可比）', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    const cases: RetrievalCase[] = [{ id: 'q_vt', query: '虚拟线程', expectedMemoryIds: ['m_vt', 'm_carrier', 'm_concurrency'] }];
    /* 基准固定 k=2：即使 params.maxResults=10，最终也只截到 2 条 → recall 受 k 约束，公平。 */
    const m = runRetrievalBenchmark(ds, cases, 2, { ...DEFAULT_RETRIEVAL_PARAMS, maxResults: 10 });
    assert.equal(m.cases[0].retrieved.length, 2, 'k 截断生效，不被 params.maxResults 绕过');
  });

  /* —— fixture 完整性断言 —— */

  it('空 case 集抛错（避免无证据的空基准）', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    assert.throws(() => runRetrievalBenchmark(ds, []), /cases must not be empty/);
  });

  it('期望记忆 id 不存在于 dataset → 抛错（暴露金标准写错 id）', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    const cases: RetrievalCase[] = [{ id: 'q_bad', query: '虚拟线程', expectedMemoryIds: ['m_does_not_exist'] }];
    assert.throws(() => runRetrievalBenchmark(ds, cases), /not present in dataset/);
  });

  it('空期望集 → 抛错（recall 无意义）', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    const cases: RetrievalCase[] = [{ id: 'q_empty', query: '虚拟线程', expectedMemoryIds: [] }];
    assert.throws(() => runRetrievalBenchmark(ds, cases), /empty expectedMemoryIds/);
  });

  it('k < 1 → 抛错', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    const cases: RetrievalCase[] = [{ id: 'q_vt', query: '虚拟线程', expectedMemoryIds: ['m_vt'] }];
    assert.throws(() => runRetrievalBenchmark(ds, cases, 0), /k must be >= 1/);
  });

  it('compareRetrievalBenchmarks: case 集不一致 → 抛错', () => {
    const ds = dataset(JAVA21_NODES, JAVA21_EDGES);
    const a = runRetrievalBenchmark(ds, [{ id: 'q1', query: '虚拟线程', expectedMemoryIds: ['m_vt'] }]);
    const b = runRetrievalBenchmark(ds, [{ id: 'q2', query: '虚拟线程', expectedMemoryIds: ['m_vt'] }]);
    assert.throws(() => compareRetrievalBenchmarks(a, b), /case sets differ/);
  });
});
