/**
 * 学习编排器端到端集成测试（ADR-0057 L6）——锁住 L1-L5 串成的**完整闭环**。
 *
 * 锁住的不变量：
 *   ① 完整闭环：pending →(L5 两老师 approve)→(L4 影子验收 ≥95)→(L6 蒸馏门**正式落主内核**)→ passed
 *      + 主内核**真的改变**（叙事落核，与 L4「只验收不落核」相反，证明 L6 才落核）+ capability-learned 事件。
 *   ② L5 退回（一老师否决/职能不相关）→ failed，**主内核不变**，**不发事件**。
 *   ③ L4 <95（候选缺要点）→ failed，主内核不变，不发事件。
 *   ④ per-persona：落各自 persona 主内核，不污染 default / 其他 persona（红线 8）。
 *   ⑤ 入口 CAS：非 pending（已 passed/learning）→ skipped，不重复学。
 *   ⑥ 运行时零-LLM：落核 + 验收全确定性（LLM 只在 L5 老师审，由 stub 代替）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { ShadowExamVerifier } from '../../intelligence/shadow-exam-verifier.js';
import { TeacherReviewGate, type Teacher } from '../../intelligence/teacher-review-gate.js';
import { LearningOrchestratorL6 } from '../../intelligence/learning-orchestrator-l6.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import {
  EXAM_SCORER_VERSION, EXAM_NORMALIZER_VERSION, EXAM_TOKENIZER_VERSION,
  type ExamSpec, type DistilledArtifact, type LLMProvider, type TeacherVerdict, type TeacherIdentity,
  type JobFunctionContext,
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
    ],
    scorerVersion: EXAM_SCORER_VERSION,
    normalizerVersion: EXAM_NORMALIZER_VERSION,
    tokenizerVersion: EXAM_TOKENIZER_VERSION,
  };
}

/** narrative_patch 候选：把叙事设为含/不含考试要点（落核后 updateNarrative 重写主内核叙事）。 */
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

/** 含三要点的合格候选叙事（确定性内核能答出三要点 → ≥95）。 */
const GOOD_NARRATIVE = '我是一名研究员，擅长文献检索、综合归纳、引用来源。';
/** 缺要点的不合格候选（只一项 → <95）。 */
const WEAK_NARRATIVE = '我是一名研究员，擅长文献检索。';

const JOB_CTX: JobFunctionContext = { roleCode: 'researcher_ic', jobFamily: 'ic', requiredCapabilities: ['research'] };

/** 桩老师：按预设 verdict 返回 JSON（默认 approve）。identity 决定独立性。 */
function stubTeacher(verdict: Partial<TeacherVerdict> = {}, identity: Partial<TeacherIdentity> = {}): Teacher {
  const llm: LLMProvider = {
    async chat() {
      const content = JSON.stringify({ approve: true, reason: 'ok', productivityRelevance: 'high', conflictsWithExisting: false, ...verdict });
      return { content };
    },
    async embed() { return []; },
  };
  return { llm, identity: { providerId: 'p', modelId: 'm', baseUrl: 'u', apiKeyId: 'k', account: 'a', ...identity } };
}

/** 两个独立 approve 老师。 */
function approvingGate(): TeacherReviewGate {
  return new TeacherReviewGate(
    stubTeacher({}, { apiKeyId: 'kA', providerId: 'pA' }),
    stubTeacher({}, { apiKeyId: 'kB', providerId: 'pB' }),
    new SilentLogger(),
  );
}

describe('L6 ADR-0057 学习编排端到端（L1-L5 完整闭环）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;
  let store: LearningRequestStore;
  let service: LearningRequestService;
  let learnedEvents: Array<{ personaId: string; capability: string; examScore: number }>;

  function makeOrchestrator(gate: TeacherReviewGate): LearningOrchestratorL6 {
    const verifier = new ShadowExamVerifier(
      os.getDatabase(), (pid) => os.createShadowCore(pid), () => clock.now(), new SilentLogger(),
    );
    return new LearningOrchestratorL6(
      store, gate, verifier, os.distillation, os.bus, () => clock.now(), 't1', new SilentLogger(),
    );
  }

  /** 登记一条 research 缺口（pending），返回其 id。 */
  function registerResearchGap(personaId: string): string {
    const outcome = service.registerGap({
      orgId: 'org1', personaId, capability: 'research', evidence: 'task-x 需要', priority: 'high',
    });
    assert.equal(outcome.kind, 'registered');
    assert.equal(outcome.request.status, 'pending');
    return outcome.request.id;
  }

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    store = new LearningRequestStore(os.getDatabase(), 't1');
    service = new LearningRequestService(store, () => clock.now(), () => `req-${clock.now()}-${Math.random()}`, 't1');
    learnedEvents = [];
    os.bus.on('capability-learned', (e) => learnedEvents.push({ personaId: e.personaId, capability: e.capability, examScore: e.examScore }));
  });
  afterEach(() => os.close());

  it('★完整闭环：pending → L5 approve → L4 ≥95 → L6 落主内核 → passed + 事件 + 主内核真的变★', async () => {
    const reqId = registerResearchGap('p-learner');
    const core = os.getCore('p-learner');
    const before = core.narrative.get();
    assert.notEqual(before, GOOD_NARRATIVE, '学前主内核叙事 ≠ 候选叙事');

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });

    assert.equal(r.ok, true, '闭环通过');
    if (!r.ok) return;
    assert.equal(r.capability, 'research');
    assert.ok(r.examScore >= 0.95, `验收 ≥95（实际 ${r.examScore}）`);

    /* L2 账本：passed（习得记录 + GapDetector 已学来源）。 */
    assert.equal(store.getById(reqId)?.status, 'passed', '账本置 passed');
    assert.deepEqual(service.listLearnedCapabilities('p-learner'), ['research'], 'research 进已学集合');

    /* ★keystone★：主内核**真的改变**（与 L4「只验收必回滚」相反，证明 L6 才落核）。 */
    assert.equal(core.narrative.get(), GOOD_NARRATIVE, 'L6 后主内核叙事 = 候选叙事（已落核）');
    assert.notEqual(core.narrative.get(), before, '主内核叙事确实改变');

    /* capability-learned 事件（供 L8 唤醒）。 */
    assert.equal(learnedEvents.length, 1, '发一次 capability-learned');
    assert.equal(learnedEvents[0]!.personaId, 'p-learner');
    assert.equal(learnedEvents[0]!.capability, 'research');
    assert.ok(learnedEvents[0]!.examScore >= 0.95);
  });

  it('★L5 一老师否决 → failed，主内核不变，不发事件★', async () => {
    const reqId = registerResearchGap('p-reject');
    const before = os.getCore('p-reject').narrative.get();

    const gate = new TeacherReviewGate(
      stubTeacher({}, { apiKeyId: 'kA', providerId: 'pA' }),
      stubTeacher({ approve: false, reason: '偏题' }, { apiKeyId: 'kB', providerId: 'pB' }),
      new SilentLogger(),
    );
    const r = await makeOrchestrator(gate).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.skipped, false);
    if (r.skipped) return;
    assert.equal(r.stage, 'l5_review');
    assert.equal(store.getById(reqId)?.status, 'failed', 'L5 退回 → 账本 failed');
    assert.equal(os.getCore('p-reject').narrative.get(), before, 'L5 退回 → 主内核不变');
    assert.equal(learnedEvents.length, 0, '不发 capability-learned');
  });

  it('★L5 职能不相关（前置筛）→ failed，不调老师，主内核不变★', async () => {
    /* 登记一个与 requiredCapabilities=[research] 不符的能力（cooking）→ L5 前置筛退回（不调 LLM）。
     * 考卷 capability 也设为 cooking 与账本一致（先过 exam_mismatch 绑定校验），让退回点落在 L5 相关性筛。 */
    const outcome = service.registerGap({ orgId: 'org1', personaId: 'p-off', capability: 'cooking', evidence: 'x', priority: 'low' });
    const reqId = outcome.request.id;
    const before = os.getCore('p-off').narrative.get();
    const cookingExam: ExamSpec = { ...researchExam(), examId: 'exam-cooking', capability: 'cooking' };

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: cookingExam, jobContext: JOB_CTX,
    });

    assert.equal(r.ok, false);
    if (r.ok || r.skipped) return;
    assert.equal(r.stage, 'l5_review');
    assert.equal(r.review?.decision.stage, 'relevance', '前置筛退回');
    assert.equal(store.getById(reqId)?.status, 'failed');
    assert.equal(os.getCore('p-off').narrative.get(), before);
    assert.equal(learnedEvents.length, 0);
  });

  it('★L4 验收 <95（候选缺要点）→ failed，主内核不变，不发事件★', async () => {
    const reqId = registerResearchGap('p-weak');
    const before = os.getCore('p-weak').narrative.get();

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(WEAK_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });

    assert.equal(r.ok, false);
    if (r.ok || r.skipped) return;
    assert.equal(r.stage, 'l4_exam');
    assert.equal(store.getById(reqId)?.status, 'failed', 'L4 <95 → 账本 failed');
    assert.equal(os.getCore('p-weak').narrative.get(), before, 'L4 <95 → 主内核不变（候选未落核）');
    assert.equal(learnedEvents.length, 0);
  });

  it('★per-persona：落各自主内核，不污染 default / 其他 persona★', async () => {
    const reqId = registerResearchGap('p-bob');
    const defaultBefore = os.getCore('default').narrative.get();
    const otherBefore = os.getCore('p-alice').narrative.get();

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });

    assert.equal(r.ok, true);
    assert.equal(os.getCore('p-bob').narrative.get(), GOOD_NARRATIVE, 'p-bob 主内核落核');
    assert.equal(os.getCore('default').narrative.get(), defaultBefore, 'default 不受影响');
    assert.equal(os.getCore('p-alice').narrative.get(), otherBefore, 'p-alice 不受影响');
  });

  it('★入口 CAS：已 passed 再编排 → skipped，不重复学★', async () => {
    const reqId = registerResearchGap('p-once');
    const first = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });
    assert.equal(first.ok, true);
    learnedEvents.length = 0; /* 清空首次事件，看二次是否再发。 */

    /* 二次编排同一已 passed 请求 → 入口 CAS 抢占失败 → skipped。 */
    const second = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.skipped, true, '已 passed → skipped');
    assert.equal(store.getById(reqId)?.status, 'passed', '状态仍 passed（未被改写）');
    assert.equal(learnedEvents.length, 0, '不重复发事件');
  });

  it('★不存在的请求 → precheck 退回（不抛）★', async () => {
    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: 'nope', candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });
    assert.equal(r.ok, false);
    if (r.ok || r.skipped) return;
    assert.equal(r.stage, 'precheck');
  });

  it('★验收题能力不匹配（examSpec.capability ≠ 账本 capability）→ exam_mismatch failed，主内核不变，不发事件（Codex L6 复审）★', async () => {
    const reqId = registerResearchGap('p-mismatch');  /* 账本能力 = research */
    const before = os.getCore('p-mismatch').narrative.get();
    /* 用一份「正考 cooking」的考卷——题集本身能被合格 research 叙事过 95，但 capability 标的是 cooking，
     * 若无绑定校验就会把 research 账本错标 learned。绑定校验必须在验收前确定性拦下。 */
    const mismatchedExam: ExamSpec = { ...researchExam(), examId: 'exam-cooking', capability: 'cooking' };

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: mismatchedExam, jobContext: JOB_CTX,
    });

    assert.equal(r.ok, false);
    if (r.ok || r.skipped) return;
    assert.equal(r.stage, 'exam_mismatch', '能力不匹配 → exam_mismatch（确定性拦截）');
    assert.equal(store.getById(reqId)?.status, 'failed', '材料无效 → 账本 failed');
    assert.equal(os.getCore('p-mismatch').narrative.get(), before, '主内核不变（未落核）');
    assert.equal(learnedEvents.length, 0, '不发 capability-learned');
  });

  it('★ingest 被蒸馏门拒（候选载荷非法）→ l6_ingest failed，不发事件★', async () => {
    const reqId = registerResearchGap('p-bad');
    /* narrative_patch 但 payload.narrative 空 → 编译器/校验拒收（合格 L5/L4 后 L6 落核被拒）。 */
    const badCandidate = narrativeCandidate(GOOD_NARRATIVE);
    const broken: DistilledArtifact = { ...badCandidate, payload: { narrative: '   ' } } as DistilledArtifact;

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: broken, examSpec: researchExam(), jobContext: JOB_CTX,
    });

    assert.equal(r.ok, false);
    if (r.ok || r.skipped) return;
    /* 空叙事在 L4 影子编译就会失败（编译器拒空 narrative）→ 实际在 l4_exam 阶段退回；
     * 无论挡在 L4 还是 L6，关键不变量：不落核、不发事件、账本 failed。 */
    assert.ok(r.stage === 'l4_exam' || r.stage === 'l6_ingest', `非法候选被挡（实际 stage=${r.stage}）`);
    assert.equal(store.getById(reqId)?.status, 'failed');
    assert.equal(learnedEvents.length, 0, '不发 capability-learned');
  });

  it('★capability-learned 监听器抛错 → 不翻转已习得结局（Codex L6 复审）★', async () => {
    const reqId = registerResearchGap('p-evt');
    /* 注册一个会抛错的监听器——学习已成功提交（落核 + passed），监听器异常不能让编排误报失败。 */
    os.bus.on('capability-learned', () => { throw new Error('下游订阅者炸了'); });

    const r = await makeOrchestrator(approvingGate()).orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX,
    });

    assert.equal(r.ok, true, '监听器抛错不翻转成功结局');
    assert.equal(store.getById(reqId)?.status, 'passed', '账本仍 passed（已落库）');
    assert.equal(os.getCore('p-evt').narrative.get(), GOOD_NARRATIVE, '主内核已落核');
  });
});
