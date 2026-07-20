import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaPerspectiveAnalyzer } from '../../collaboration/persona-perspective-analyzer.js';
import type { RelevantKnowledge } from '../../conversation/conversation-types.js';
import type { AutonomousDecisionEngine } from '../../intelligence/decision-engine.js';

/** 极简 fake：把注入的检索/决策/组织三基元替换为可控桩，聚焦 analyzer 的映射与门控逻辑。 */
function makeAnalyzer(opts: {
  knowledge: RelevantKnowledge[];
  kind?: 'knowledge_grounded' | 'honest_offline' | 'boundary_block' | 'boundary_escalate';
  ranked?: { alternative: string; rank: number; overallScore: number }[];
}) {
  return new PersonaPerspectiveAnalyzer({
    retrieve: () => opts.knowledge,                                   // 注入检索桩
    decisionEngine: { evaluateAutonomous: () => ({ caseId: 'c', recommendedAlternative: opts.ranked?.[0]?.alternative ?? '', rankedOptions: opts.ranked ?? [], simulatedAt: 0 }) } as unknown as AutonomousDecisionEngine,
    responder: { respond: () => ({ content: 'op', kind: opts.kind ?? 'knowledge_grounded' }) } as any,
    narrative: 'n',
    boundaries: [],
  });
}

test('grounded：映射 evidence（id→memoryId, content→excerpt, isAssociation→association）+ retrievedCount + keyPoints', () => {
  const a = makeAnalyzer({ knowledge: [
    { id: 'm1', title: '', content: '预算 约束 收紧', relevance: 0.7 },
    { id: 'm2', title: '', content: '市场 需求 上升', relevance: 0.4, isAssociation: true },
  ]});
  const p = a.analyze('persona-x', { question: '要不要扩张' });
  assert.equal(p.kind, 'knowledge_grounded');
  assert.equal(p.retrievedCount, 2);
  assert.equal(p.evidence.length, 2);
  assert.deepEqual(p.evidence.map((e) => e.memoryId), ['m1', 'm2']);
  assert.equal(p.evidence[0].excerpt, '预算 约束 收紧');
  assert.equal(p.evidence[0].association, false);   // 缺省 isAssociation → false
  assert.equal(p.evidence[1].association, true);
  assert.ok(p.keyPoints.length > 0);
});

test('honest_offline：evidence/keyPoints 为空，retrievedCount 仍如实', () => {
  const a = makeAnalyzer({ knowledge: [{ id: 'm1', title: '', content: '无关内容', relevance: 0.1 }], kind: 'honest_offline' });
  const p = a.analyze('persona-y', { question: 'q' });
  assert.equal(p.kind, 'honest_offline');
  assert.deepEqual(p.evidence, []);
  assert.deepEqual(p.keyPoints, []);
  assert.equal(p.retrievedCount, 1);   // 检索到 1 条，只是 responder 判定离线
});

test('带 alternatives：rankedAlternatives 从 rankedOptions 映射（overallScore→score）', () => {
  const a = makeAnalyzer({ knowledge: [{ id: 'm1', title: '', content: '扩张 有利', relevance: 0.8 }], ranked: [
    { alternative: '扩张', rank: 1, overallScore: 0.9 },
    { alternative: '收缩', rank: 2, overallScore: 0.3 },
  ]});
  const p = a.analyze('persona-z', { question: 'q', alternatives: ['扩张', '收缩'] });
  assert.deepEqual(p.rankedAlternatives, [
    { alternative: '扩张', score: 0.9, rank: 1 },
    { alternative: '收缩', score: 0.3, rank: 2 },
  ]);
});

test('boundary_block：evidence/keyPoints 空，kind 透传', () => {
  const a = makeAnalyzer({ knowledge: [], kind: 'boundary_block' });
  const p = a.analyze('persona-b', { question: '禁忌话题' });
  assert.equal(p.kind, 'boundary_block');
  assert.deepEqual(p.evidence, []);
  assert.deepEqual(p.keyPoints, []);
});
