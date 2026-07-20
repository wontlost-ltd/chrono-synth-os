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
// boundary 视角：类型允许 keyPoints 非空（测最坏情况——实现是否正确排除，而非依赖桩给空数组占便宜）
const boundary = (id: string, keyPoints: string[]): PersonaPerspective => ({
  personaId: id, opinion: '涉及禁忌领域', kind: 'boundary_block', retrievedCount: 0, evidence: [], keyPoints,
});

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
  // pin 实现内稳定序（raisedBy 内部已 [...raisers].sort()），不在测试侧再排序——防实现序回归
  assert.deepEqual(topic!.raisedBy, ['a', 'b']);
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

// --- 补测：Important 1 — rankingDivergences 同候选同 rank 不算分歧 ---
test('rankingDivergences：同候选被排到相同 rank → 不入分歧（非分歧被误判）', () => {
  const r = mode.aggregate('q', [
    grounded('a', ['x'], [{ alternative: '扩张', score: 0.9, rank: 1 }]),
    grounded('b', ['y'], [{ alternative: '扩张', score: 0.8, rank: 1 }]),
  ]);
  const d = r.rankingDivergences.find((x) => x.alternative === '扩张');
  assert.equal(d, undefined);
});

// --- 补测：Important 2 — boundary 视角须被排除（keyPoints 非空的最坏情况） ---
test('boundary_block 视角不计入 grounded 数，也不进 commonTopics（即便 keyPoints 非空）', () => {
  const r = mode.aggregate('q', [
    grounded('a', ['预算']),
    boundary('b', ['预算']),
    offline('c'),
  ]);
  assert.equal(r.status, 'analyzed');
  // total=3, g 应为 1（仅 a），非 2（若误纳 boundary）：groundingNote 走「不足」分支（1 < ceil(3/2)=2）
  assert.match(r.groundingNote, /仅 1 个视角有依据/);
  // boundary 的 keyPoint「预算」即便与 grounded 的「预算」同名，也不应因 boundary 参与计数而进入 commonTopics
  // （commonTopics 要求 ≥2 个 grounded persona 提及；此处 grounded 只有 1 个，故不会有任何 commonTopics）
  assert.equal(r.commonTopics.find((t) => t.topic === '预算'), undefined);
});

// --- 补测：Important 3 — evidenceBrief 内容（此前零覆盖） ---
test('evidenceBrief（analyzed）：含头部串 + 含 grounded persona 的证据依据行', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算', '市场']), grounded('b', ['预算'])]);
  assert.match(r.evidenceBrief, /证据摘要（确定性汇总，非综合建议）/);
  assert.match(r.evidenceBrief, /共同关注话题/);
  assert.match(r.evidenceBrief, /a 依据：a-0:预算/);
  assert.match(r.evidenceBrief, /b 依据：b-0:预算/);
});

test('evidenceBrief（insufficient_grounding）：含「无证据摘要」串', () => {
  const r = mode.aggregate('q', [offline('a'), offline('b')]);
  assert.match(r.evidenceBrief, /无证据摘要/);
});

// --- 补测：Minor 5 — groundingNote total=2/G=1 边界（ceil(2/2)=1, 1<1 为假）应落「基于…」分支非「不足」 ---
test('groundingNote 边界：total=2,G=1 → 落「基于…有据」分支，非「不足」分支', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算']), offline('b')]);
  assert.match(r.groundingNote, /^基于 2 位数字人各自学习积累（1 个视角有据）/);
  assert.doesNotMatch(r.groundingNote, /不足/);
});

// --- 补测：Minor 6 — 两 grounded keyPoints 无交集 → commonTopics 空 ---
test('两 grounded persona keyPoints 无交集 → commonTopics 为空', () => {
  const r = mode.aggregate('q', [grounded('a', ['预算']), grounded('b', ['市场'])]);
  assert.equal(r.commonTopics.length, 0);
});
