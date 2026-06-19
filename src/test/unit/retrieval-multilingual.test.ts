import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMemoriesDeterministic } from '../../conversation/deterministic-memory-retrieval.js';
import type { MemoryId, MemoryNode, MemoryEdge } from '@chrono/kernel';

function mem(id: string, content: string): MemoryNode {
  return {
    id, kind: 'semantic', content, valence: 0, salience: 0.7, createdAt: 1000,
    lastAccessedAt: 1000, accessCount: 0, decayLambda: 0, lastDecayedAt: 1000, consolidatedFrom: null,
  };
}
const noEdges = (): MemoryEdge[] => [];

/* ADR-0055 内容多语：contentFor 让英文 query 命中已翻译成英文的中文记忆。 */
describe('retrieveMemoriesDeterministic 多语（contentFor）', () => {
  const memories: ReadonlyMap<MemoryId, MemoryNode> = new Map([
    ['m1', mem('m1', '我学过危机管理：先稳定再优化')],
    ['m2', mem('m2', '我喜欢手冲咖啡')],
  ]);
  /* m1 的英文变体。 */
  const enVariants = new Map([['m1', 'I learned crisis management: stabilize first, then optimize']]);
  const contentFor = (node: MemoryNode): string => enVariants.get(node.id) ?? node.content;

  it('无 contentFor：英文 query 命中不到中文记忆（基线，说明问题）', () => {
    const hits = retrieveMemoriesDeterministic('crisis management', memories, noEdges);
    assert.equal(hits.length, 0, '纯中文记忆英文 query 零命中');
  });

  it('有 contentFor：英文 query 命中翻译变体 → 召回原记忆，且呈现英文', () => {
    const hits = retrieveMemoriesDeterministic('crisis management', memories, noEdges, undefined, contentFor);
    assert.ok(hits.length >= 1, '应命中翻译过的记忆');
    assert.equal(hits[0].id, 'm1', '命中 m1');
    assert.match(hits[0].content, /crisis management/i, '呈现英文变体而非中文原文');
    assert.ok(!/[一-鿿]/.test(hits[0].content), '呈现不含中文');
  });

  it('未翻译的记忆英文 query 仍命中不到（诚实局限）', () => {
    const hits = retrieveMemoriesDeterministic('coffee', memories, noEdges, undefined, contentFor);
    /* m2 无英文变体，英文 query "coffee" 匹配不到中文「手冲咖啡」。 */
    assert.equal(hits.length, 0, '未翻译记忆英文命中不到');
  });

  it('中文 query 无 contentFor（zh 路径）：仍命中中文记忆（零回归）', () => {
    const hits = retrieveMemoriesDeterministic('危机管理', memories, noEdges);
    assert.ok(hits.length >= 1, '中文 query 命中中文记忆');
    assert.equal(hits[0].id, 'm1');
    assert.match(hits[0].content, /危机管理/);
  });

  it('确定性：相同输入 → 相同输出', () => {
    const a = retrieveMemoriesDeterministic('crisis', memories, noEdges, undefined, contentFor);
    const b = retrieveMemoriesDeterministic('crisis', memories, noEdges, undefined, contentFor);
    assert.deepEqual(a, b);
  });
});
