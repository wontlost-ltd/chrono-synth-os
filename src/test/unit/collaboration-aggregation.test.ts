import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiPerspectiveAggregation } from '../../collaboration/modes/multi-perspective-aggregation.js';
import type { PersonaPerspective } from '../../collaboration/collaboration-types.js';

const grounded = (id: string, keyPoints: string[], ranked?: { alternative: string; score: number; rank: number }[]): PersonaPerspective => ({
  personaId: id, opinion: 'o', kind: 'knowledge_grounded', retrievedCount: keyPoints.length,
  evidence: keyPoints.map((k, i) => ({ memoryId: `${id}-${i}`, excerpt: k, relevance: 0.5, association: false })),
  keyPoints, ...(ranked ? { rankedAlternatives: ranked } : {}),
});
const offline = (id: string): PersonaPerspective => ({ personaId: id, opinion: '暂无积累', kind: 'honest_offline', retrievedCount: 0, evidence: [], keyPoints: [] });

const mode = new MultiPerspectiveAggregation();

test('modeId = multi_perspective + requiresHumanApproval 恒 true', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算'])]);
  assert.equal(r.modeId, 'multi_perspective');
  assert.equal(r.requiresHumanApproval, true);
});

test('commonTopics：两 grounded 共提「预算」→ 入 commonTopics，raisedBy 含两者', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算', '市场']), grounded('b', ['预算', '风险'])]);
  const topic = r.commonTopics.find((t) => t.topic === '预算');
  assert.ok(topic);
  assert.deepEqual([...topic!.raisedBy].sort(), ['a', 'b']);
});

test('honest_offline 的套话不进 commonTopics', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算']), offline('b')]);
  assert.equal(r.commonTopics.length, 0);   // 只一个 grounded persona，无共同（需 ≥2）
});

test('全 offline → insufficient_grounding + 空话题/分歧', () => {
  const r = mode.aggregate('q', [offline('a'), offline('b')]);
  assert.equal(r.status, 'insufficient_grounding');
  assert.deepEqual(r.commonTopics, []);
  assert.deepEqual(r.rankingDivergences, []);
  assert.ok(r.groundingNote.length > 0);
});

test('≥1 grounded → analyzed；G<半数 → groundingNote 标积累不足', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算']), offline('b'), offline('c')]);
  assert.equal(r.status, 'analyzed');
  assert.match(r.groundingNote, /不足|仅/);
});

test('rankingDivergences：同候选被排到不同 rank → 入分歧', () => {
  const r = mode.aggregate('q', [
    grounded('a', ['x'], [{ alternative: '扩张', score: 0.9, rank: 1 }, { alternative: '收缩', score: 0.2, rank: 2 }]),
    grounded('b', ['y'], [{ alternative: '扩张', score: 0.3, rank: 2 }, { alternative: '收缩', score: 0.8, rank: 1 }]),
  ]);
  const d = r.rankingDivergences.find((x) => x.alternative === '扩张');
  assert.ok(d);
  assert.deepEqual(d!.rankings.map((r) => r.rank).sort(), [1, 2]);
});

test('确定性：同输入两次 aggregate 结果全等', () => {
  const input: PersonaPerspective[] = [grounded('a', ['预算', '市场']), grounded('b', ['预算'])];
  assert.deepEqual(mode.aggregate('q', input), mode.aggregate('q', input));
});
