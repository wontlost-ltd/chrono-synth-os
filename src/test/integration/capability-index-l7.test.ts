/**
 * 能力索引 L7 集成测试（ADR-0057 L7）——锁住「已学能力正式化」闭环。
 *
 * 锁住的不变量：
 *   ① capability_index 表随迁移建好；CapabilityIndexStore upsert/查确定性。
 *   ② 投影器订阅 capability-learned → 投影一行；同 (persona,cap) 重学 = 更新非新增（唯一索引）。
 *   ③ tenantId 缺失 → drop（不跨租户写）；投影失败隔离（不抛进 bus.emit）。
 *   ④ **真闭环**：L6 orchestrate 落核发 capability-learned → 投影器写索引 → LearningRequestService
 *      据索引算「已学」→ GapDetector 不再把该能力当缺口（零重复请教）。
 *   ⑤ per-persona：各 persona 各自索引，不串。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { ShadowExamVerifier } from '../../intelligence/shadow-exam-verifier.js';
import { TeacherReviewGate, type Teacher } from '../../intelligence/teacher-review-gate.js';
import { LearningOrchestratorL6 } from '../../intelligence/learning-orchestrator-l6.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import {
  EXAM_SCORER_VERSION, EXAM_NORMALIZER_VERSION, EXAM_TOKENIZER_VERSION,
  type ExamSpec, type DistilledArtifact, type LLMProvider, type TeacherIdentity, type JobFunctionContext,
} from '@chrono/kernel';

function researchExam(): ExamSpec {
  return {
    examId: 'exam-research', capability: 'research',
    questions: [{ id: 'q1', question: '你是谁，擅长什么？' }],
    keypoints: [
      { id: 'kp-search', weight: 1, aliases: ['文献检索'] },
      { id: 'kp-synth', weight: 1, aliases: ['综合归纳'] },
      { id: 'kp-cite', weight: 1, aliases: ['引用来源'] },
    ],
    forbiddenClaims: [{ id: 'fb', aliases: ['编造数据'] }],
    structuredFields: [],
    negativeCases: [{ id: 'n1', answer: '', reason: '空' }],
    scorerVersion: EXAM_SCORER_VERSION, normalizerVersion: EXAM_NORMALIZER_VERSION, tokenizerVersion: EXAM_TOKENIZER_VERSION,
  };
}
const GOOD_NARRATIVE = '我是一名研究员，擅长文献检索、综合归纳、引用来源。';
const JOB_CTX: JobFunctionContext = { roleCode: 'researcher_ic', jobFamily: 'ic', requiredCapabilities: ['research'] };

function narrativeCandidate(narrative: string): DistilledArtifact {
  return {
    id: `dart-${narrative.length}`, kind: 'narrative_patch', source: 'reflection',
    payload: { narrative }, confidence: 0.95, evidence: [{ type: 'test', id: 'e1', score: 1 }],
    status: 'candidate', createdAt: 1000,
  } as DistilledArtifact;
}
function stubTeacher(identity: Partial<TeacherIdentity>): Teacher {
  const llm: LLMProvider = {
    async chat() { return { content: JSON.stringify({ approve: true, reason: 'ok', productivityRelevance: 'high', conflictsWithExisting: false }) }; },
    async embed() { return []; },
  };
  return { llm, identity: { providerId: 'p', modelId: 'm', baseUrl: 'u', apiKeyId: 'k', account: 'a', ...identity } };
}
function approvingGate(): TeacherReviewGate {
  return new TeacherReviewGate(stubTeacher({ apiKeyId: 'kA', providerId: 'pA' }), stubTeacher({ apiKeyId: 'kB', providerId: 'pB' }), new SilentLogger());
}

describe('L7 ADR-0057 能力索引（已学能力正式化 + 闭环）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();  /* 启动投影器订阅 capability-learned。 */
  });
  afterEach(() => os.close());

  it('★capability_index 表建好 + store upsert/查确定性★', () => {
    const store = new CapabilityIndexStore(os.getDatabase(), 't1');
    assert.deepEqual(store.listLearnedCapabilities('p1'), [], '初始无');
    store.upsert({ id: 'i1', personaId: 'p1', capability: 'research', examScore: 0.97, learningRequestId: 'r1', capabilityVersion: 1, learnedAt: 2000, updatedAt: 2000 });
    assert.deepEqual(store.listLearnedCapabilities('p1'), ['research']);
    const entry = store.getByCapability('p1', 'research');
    assert.equal(entry?.examScore, 0.97);
    assert.equal(entry?.learnedAt, 2000, 'bigint 强转正确');
  });

  it('★同 (persona,cap) 重学 = 更新非新增（唯一索引幂等）★', () => {
    const store = new CapabilityIndexStore(os.getDatabase(), 't1');
    store.upsert({ id: 'i1', personaId: 'p1', capability: 'research', examScore: 0.96, learningRequestId: 'r1', capabilityVersion: 1, learnedAt: 2000, updatedAt: 2000 });
    store.upsert({ id: 'i2', personaId: 'p1', capability: 'research', examScore: 0.99, learningRequestId: 'r2', capabilityVersion: 1, learnedAt: 3000, updatedAt: 3000 });
    assert.equal(store.listByPersona('p1').length, 1, '一项能力一行');
    assert.equal(store.getByCapability('p1', 'research')?.examScore, 0.99, '更新为最新分数');
    assert.equal(store.getByCapability('p1', 'research')?.id, 'i1', 'id 保持首次（审计稳定）');
  });

  it('★per-persona 隔离：各自索引不串★', () => {
    const store = new CapabilityIndexStore(os.getDatabase(), 't1');
    store.upsert({ id: 'a', personaId: 'pa', capability: 'research', examScore: 0.96, learningRequestId: 'r', capabilityVersion: 1, learnedAt: 2000, updatedAt: 2000 });
    store.upsert({ id: 'b', personaId: 'pb', capability: 'writing', examScore: 0.96, learningRequestId: 'r', capabilityVersion: 1, learnedAt: 2000, updatedAt: 2000 });
    assert.deepEqual(store.listLearnedCapabilities('pa'), ['research']);
    assert.deepEqual(store.listLearnedCapabilities('pb'), ['writing']);
  });

  it('★投影器：capability-learned 事件 → 写索引★', () => {
    os.bus.emit('capability-learned', { personaId: 'p-evt', capability: 'research', learningRequestId: 'req1', examScore: 0.98, learnedAt: 5000, tenantId: 't1' });
    const store = new CapabilityIndexStore(os.getDatabase(), 't1');
    assert.deepEqual(store.listLearnedCapabilities('p-evt'), ['research'], '事件已投影');
    assert.equal(store.getByCapability('p-evt', 'research')?.learningRequestId, 'req1', '审计链回指');
  });

  it('★投影器：tenantId 缺失 → drop（不跨租户写）★', () => {
    os.bus.emit('capability-learned', { personaId: 'p-x', capability: 'research', learningRequestId: 'r', examScore: 0.98, learnedAt: 5000 } as never);
    const store = new CapabilityIndexStore(os.getDatabase(), 't1');
    assert.deepEqual(store.listLearnedCapabilities('p-x'), [], '缺 tenantId → 未投影');
  });

  it('★真闭环：L6 落核发事件 → 投影索引 → GapDetector 不再当缺口（零重复请教）★', async () => {
    const store = new LearningRequestStore(os.getDatabase(), 't1');
    const indexStore = new CapabilityIndexStore(os.getDatabase(), 't1');
    const service = new LearningRequestService(store, () => clock.now(), () => `req-${clock.now()}-${Math.random()}`, 't1', indexStore);

    /* 1. 登记 research 缺口（pending）。 */
    const reqId = service.registerGap({ orgId: 'o1', personaId: 'p-loop', capability: 'research', evidence: 'x', priority: 'high' }).request.id;
    /* 学前：GapDetector 认为 research 是缺口。 */
    assert.deepEqual(service.listLearnedCapabilities('p-loop'), [], '学前无已学');
    const before = service.detectAndRegister({ orgId: 'o1', personaId: 'p-loop', requiredCapabilities: ['research'], taskId: 't' });
    assert.ok(before.some((o) => o.capability === 'research'), '学前 research 是缺口（deduped 复用已登记）');

    /* 2. L6 orchestrate 落核 → 发 capability-learned → 投影器写索引。 */
    const orchestrator = new LearningOrchestratorL6(
      store, approvingGate(),
      new ShadowExamVerifier(os.getDatabase(), (pid) => os.createShadowCore(pid), () => clock.now(), new SilentLogger()),
      os.distillation, os.bus, () => clock.now(), 't1', new SilentLogger(),
    );
    const r = await orchestrator.orchestrate({ learningRequestId: reqId, candidate: narrativeCandidate(GOOD_NARRATIVE), examSpec: researchExam(), jobContext: JOB_CTX });
    assert.equal(r.ok, true, 'L6 落核成功');

    /* 3. 索引已写（投影器同步处理了事件）。 */
    assert.deepEqual(indexStore.listLearnedCapabilities('p-loop'), ['research'], '索引已记 research');

    /* 4. ★闭环★：GapDetector 据索引算「已学」→ research 不再是缺口。 */
    assert.ok(service.listLearnedCapabilities('p-loop').includes('research'), '已学集合含 research');
    const after = service.detectAndRegister({ orgId: 'o1', personaId: 'p-loop', requiredCapabilities: ['research'], taskId: 't2' });
    assert.equal(after.length, 0, '学会后 research 不再是缺口（零重复请教）');
  });

  it('★向后兼容：未注入索引 → 回退 L2 passed 扫描★', () => {
    const store = new LearningRequestStore(os.getDatabase(), 't1');
    /* 不注入 CapabilityIndexStore（旧调用方）。 */
    const service = new LearningRequestService(store, () => clock.now(), () => `req-${Math.random()}`, 't1');
    /* 手动落一条 passed（模拟 L2 时代已学）。 */
    const reqId = service.registerGap({ orgId: 'o1', personaId: 'p-compat', capability: 'writing', evidence: 'x', priority: 'low' }).request.id;
    store.transitionStatus(reqId, 'pending', 'learning', clock.now());
    store.transitionStatus(reqId, 'learning', 'passed', clock.now());
    assert.deepEqual(service.listLearnedCapabilities('p-compat'), ['writing'], '无索引时读 L2 passed');
  });

  it('★并集兜底：索引有 research + L2 passed 有 writing → 两者都算已学★', () => {
    const store = new LearningRequestStore(os.getDatabase(), 't1');
    const indexStore = new CapabilityIndexStore(os.getDatabase(), 't1');
    const service = new LearningRequestService(store, () => clock.now(), () => `req-${Math.random()}`, 't1', indexStore);
    /* L2 passed: writing（存量，无索引行）。 */
    const reqId = service.registerGap({ orgId: 'o1', personaId: 'p-union', capability: 'writing', evidence: 'x', priority: 'low' }).request.id;
    store.transitionStatus(reqId, 'pending', 'learning', clock.now());
    store.transitionStatus(reqId, 'learning', 'passed', clock.now());
    /* 索引: research（新学）。 */
    indexStore.upsert({ id: 'i', personaId: 'p-union', capability: 'research', examScore: 0.97, learningRequestId: 'r', capabilityVersion: 1, learnedAt: 2000, updatedAt: 2000 });
    assert.deepEqual(service.listLearnedCapabilities('p-union'), ['research', 'writing'], '并集 + 确定性排序');
  });
});
