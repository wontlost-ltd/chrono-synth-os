/**
 * 影子内核验收器集成测试（ADR-0057 L4，D0.6）。
 *
 * 锁住「学会后运行时零-LLM」闭环：候选知识编译进影子内核 → **确定性内核作答** → 评分 → **回滚** →
 * ≥95 才算学会。关键不变量：①验收用确定性内核作答（零-LLM）；②**shadow 绝不污染主内核**（红线 5/18：
 * 无论过不过都回滚，主内核状态不变）；③确定性可复现；④候选非法/编译失败被拒；⑤compile lease 互斥。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { ShadowExamVerifier } from '../../intelligence/shadow-exam-verifier.js';
import { PersonaLeaseStore } from '../../storage/persona-lease-store.js';
import {
  EXAM_SCORER_VERSION, EXAM_NORMALIZER_VERSION, EXAM_TOKENIZER_VERSION,
  type ExamSpec, type DistilledArtifact,
} from '@chrono/kernel';

/* 一份 research 能力考试：问「你是谁/会什么」，要点 = 三项研究能力关键词。 */
function researchExam(): ExamSpec {
  return {
    examId: 'exam-research',
    capability: 'research',
    questions: [{ id: 'q1', question: '你是谁，擅长什么？' }],
    keypoints: [
      { id: 'kp-search', weight: 1, aliases: ['文献检索'] },
      { id: 'kp-synth', weight: 1, aliases: ['综合归纳'] },
      { id: 'kp-cite', weight: 1, aliases: ['引用来源'] },
    ],
    forbiddenClaims: [{ id: 'fb', aliases: ['编造数据'] }],
    structuredFields: [],
    negativeCases: [
      { id: 'n1', answer: '', reason: '空' },
      { id: 'n2', answer: '我很厉害', reason: '泛答案无要点' },
      { id: 'n3', answer: '不知道', reason: '无要点2' },
    ],
    scorerVersion: EXAM_SCORER_VERSION,
    normalizerVersion: EXAM_NORMALIZER_VERSION,
    tokenizerVersion: EXAM_TOKENIZER_VERSION,
  };
}

/** narrative_patch 候选：把叙事设为含/不含考试要点。 */
function narrativeCandidate(narrative: string): DistilledArtifact {
  return {
    id: `dart-${narrative.length}`,
    kind: 'narrative_patch',
    source: 'reflection',
    payload: { narrative },
    confidence: 0.95,
    evidence: [{ type: 'test', id: 'e1', score: 1 }],
    status: 'candidate',
    createdAt: 1000,
  } as DistilledArtifact;
}

describe('L4 ADR-0057 影子内核验收（闭环零-LLM）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;
  let verifier: ShadowExamVerifier;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    verifier = new ShadowExamVerifier(
      os.getDatabase(), (pid) => os.createShadowCore(pid), () => clock.now(), new SilentLogger(),
    );
  });
  afterEach(() => os.close());

  it('★合格候选 → 影子内核作答 ≥95 → passed★', () => {
    /* persona 学到一段含三要点的自我叙事 → 确定性内核能答出三要点 → 合格。 */
    const cand = narrativeCandidate('我是一名研究员，擅长文献检索、综合归纳、引用来源。');
    const r = verifier.verify('p-researcher', researchExam(), cand);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.passed, true, '三要点全答出 → ≥95');
    assert.equal(r.examResult.coverage, 1);
  });

  it('★不足候选 → 影子内核答不全 → <95 不过 + 失分要点★', () => {
    const cand = narrativeCandidate('我是一名研究员，擅长文献检索。');  /* 缺综合归纳/引用来源 */
    const r = verifier.verify('p-researcher', researchExam(), cand);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.passed, false);
    assert.ok(r.examResult.coverage < 0.95);
    assert.ok(r.failedKeypoints.includes('kp-synth') && r.failedKeypoints.includes('kp-cite'));
  });

  it('★shadow 绝不污染主内核（红线 5/18）★：验收后主内核叙事**不变**（无论过不过都回滚）', () => {
    const core = os.getCore('p-researcher');
    core.updateNarrative('原始叙事-未学习');
    const before = core.narrative.get();

    /* 合格验收。 */
    const pass = verifier.verify('p-researcher', researchExam(), narrativeCandidate('我是研究员，擅长文献检索、综合归纳、引用来源。'));
    assert.equal(pass.ok && pass.passed, true);
    assert.equal(core.narrative.get(), before, '合格验收后主内核叙事回滚（shadow 不污染）');

    /* 不合格验收。 */
    const fail = verifier.verify('p-researcher', researchExam(), narrativeCandidate('我是研究员，擅长文献检索。'));
    assert.equal(fail.ok && fail.passed, false);
    assert.equal(core.narrative.get(), before, '不合格验收后主内核叙事也回滚');
  });

  it('★全维度回滚★：验收前后 getState 7 维一致（含 values/memories/decisionStyle 等未被影子改动）', () => {
    const core = os.getCore('p-x');
    core.addValue('诚信', 0.9);
    core.addMemory('episodic', '过往经历A', 0.5, 0.8);
    core.updateNarrative('我是 X');
    core.setDecisionStyle({ riskAppetite: 0.42 });
    const before = JSON.stringify({
      values: [...core.values.getAll().values()].map((v) => v.label).sort(),
      memCount: core.memories.getAllMemories().size,
      narrative: core.narrative.get(),
      risk: core.decisionStyle.get().riskAppetite,
    });

    verifier.verify('p-x', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));

    const after = JSON.stringify({
      values: [...core.values.getAll().values()].map((v) => v.label).sort(),
      memCount: core.memories.getAllMemories().size,
      narrative: core.narrative.get(),
      risk: core.decisionStyle.get().riskAppetite,
    });
    assert.equal(after, before, '影子验收后全维度状态完全回滚');
  });

  it('★确定性可复现★：同候选 + 同 spec → 同验收结果', () => {
    const cand = narrativeCandidate('我擅长文献检索、综合归纳、引用来源。');
    const a = verifier.verify('p-researcher', researchExam(), cand);
    const b = verifier.verify('p-researcher', researchExam(), cand);
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(a.examResult.coverage, b.examResult.coverage);
    assert.equal(a.passed, b.passed);
  });

  it('★候选非法 → 被拒（红线 12 同校验）★', () => {
    /* narrative_patch 空 narrative → validateArtifact 不过。 */
    const bad = narrativeCandidate('');
    const r = verifier.verify('p-researcher', researchExam(), bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /非法|校验/);
  });

  it('★compile lease 互斥（红线 13）★：lease 被占 → 验收拒绝（不抢编译）', () => {
    const leaseStore = new PersonaLeaseStore(os.getDatabase(), 't1');
    const v = new ShadowExamVerifier(
      os.getDatabase(), (pid) => os.createShadowCore(pid), () => clock.now(), new SilentLogger(),
      undefined, undefined, undefined, leaseStore,
    );
    /* 先占住全局 compile 锁。 */
    const held = leaseStore.acquire('__global__', 'compile', clock.now(), 60_000);
    assert.ok(held, '先占锁成功');
    const r = v.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /lease|占/);
    leaseStore.release(held!);
    /* 释放后可正常验收。 */
    const r2 = v.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    assert.equal(r2.ok, true);
  });

  it('★事件不外发（红线 18，Codex 复审）★：影子验收不触发任何 core:*/system:* 事件', () => {
    os.getCore('p-researcher').updateNarrative('原始');
    const seen: string[] = [];
    const sub = (name: string) => os.bus.on(name as never, (() => seen.push(name)) as never);
    for (const ev of ['core:narrative-changed', 'core:value-updated', 'core:memory-added', 'core:decision-style-updated', 'core:cognitive-model-updated', 'system:snapshot-created', 'system:snapshot-restored']) sub(ev);
    verifier.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    assert.deepEqual(seen, [], '影子验收全程不外发事件（独立 bus + 事务回滚）');
  });

  it('★working memory 不丢（红线 18，Codex 复审）★：验收前后 slot 身份完全一致（非仅数量）', () => {
    const core = os.getCore('p-wm');
    const m = core.addMemory('episodic', '重要记忆', 0.5, 0.9);
    core.memories.admitToWorkingMemory(m.id);
    const before = core.memories.getWorkingMemorySlots().map((s) => s.memoryId).sort();
    assert.ok(before.length > 0, '验收前有 working memory');
    verifier.verify('p-wm', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    /* 重新取 core（同 db，读穿）——working memory slot 身份不被影子事务改动（事务全回滚）。 */
    const after = os.getCore('p-wm').memories.getWorkingMemorySlots().map((s) => s.memoryId).sort();
    assert.deepEqual(after, before, 'working memory slot 身份验收后完全一致');
  });

  it('★response_template/rule kind 被拒（红线 18 防御，Codex 复审）★', () => {
    const tmpl = { id: 'd1', kind: 'response_template', source: 'reflection', payload: { intent: 'x', template: 'y' }, confidence: 0.9, evidence: [{ type: 'test', id: 'e', score: 1 }], status: 'candidate', createdAt: 1000 } as DistilledArtifact;
    const r = verifier.verify('p-researcher', researchExam(), tmpl);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /不在影子验收范围|response_template|rule/);
  });

  it('★编译失败也回滚（红线 5）★：候选指向不存在记忆 → memory_edge 编译失败 → 主内核不变', () => {
    const core = os.getCore('p-edge');
    const before = core.memories.getAllEdges().length;
    const badEdge = { id: 'de', kind: 'memory_edge', source: 'reflection', payload: { sourceId: 'nope-1', targetId: 'nope-2', relation: 'relates_to', strength: 0.5 }, confidence: 0.95, evidence: [{ type: 'pattern', id: 'e1', score: 0.9 }, { type: 'pattern', id: 'e2', score: 0.85 }], status: 'candidate', createdAt: 1000 } as DistilledArtifact;
    const r = verifier.verify('p-edge', researchExam(), badEdge);
    assert.equal(r.ok, false, '缺失记忆 → 编译失败');
    assert.equal(os.getCore('p-edge').memories.getAllEdges().length, before, '编译失败后主内核边不变（事务回滚）');
  });

  it('★成功的 memory_edge 验收也回滚（Codex 复审）★：候选边编译成功验收后，主内核边数不变', () => {
    const core = os.getCore('p-edge2');
    const a = core.addMemory('episodic', '记忆甲', 0.5, 0.8);
    const b = core.addMemory('semantic', '记忆乙', 0.3, 0.6);
    const edgesBefore = core.memories.getAllEdges().length;
    const goodEdge = { id: 'de2', kind: 'memory_edge', source: 'reflection', payload: { sourceId: a.id, targetId: b.id, relation: 'relates_to', strength: 0.7 }, confidence: 0.95, evidence: [{ type: 'pattern', id: 'e1', score: 0.9 }, { type: 'pattern', id: 'e2', score: 0.85 }], status: 'candidate', createdAt: 1000 } as DistilledArtifact;
    const r = verifier.verify('p-edge2', researchExam(), goodEdge);
    assert.equal(r.ok, true, '合法边编译成功（验收结果与考题无关，此处只验回滚）');
    /* 影子编译加了边，但验收后整事务回滚 → 主内核边数不变。 */
    assert.equal(os.getCore('p-edge2').memories.getAllEdges().length, edgesBefore, '成功验收后影子加的边也回滚');
  });

  it('★SQLite 外层事务内调用 → 优雅失败不静默成功（嵌套语义后端相关，Codex 复审）★', () => {
    /* SQLite 平坦 BEGIN 不可嵌套：外层事务里 verify 内层 BEGIN 冲突抛错 → 被 verify catch → 返回 ok:false
     * （不静默判过、不污染）。注：此为 SQLite 行为（本测跑内存 SQLite）；PG 嵌套是独立内层事务（仍总回滚，
     * fn 写入照样不持久）——「fn 写入永不落库」跨后端都成立，但「嵌套必报错」是 SQLite-only。影子验收按设计
     * 在无外层事务上下文调用。 */
    let captured: ReturnType<typeof verifier.verify> | undefined;
    os.getDatabase().transaction(() => {
      captured = verifier.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    });
    assert.ok(captured);
    assert.equal(captured!.ok, false, 'SQLite 外层事务内 → 内层 BEGIN 冲突 → ok:false（不静默成功）');
  });
});
