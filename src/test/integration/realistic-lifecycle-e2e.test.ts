/**
 * 真实生命周期深度集成 E2E（模拟现实，2026-06-22）——把四条业务线串成一个连续的现实故事，
 * 混合**真实 HTTP 服务层**（fastify inject，经认证/租户隔离/Zod schema/真实路由）与**深层 in-process
 * service**（L4 影子验收 / L6 编排 / L5/L5b 双老师互审，无 HTTP 路由），共享同一数据库。
 *
 * 故事：一名新研究员入职数字组织 → 接到研究任务但**缺 research 能力** → 经完整按职能进修闭环学会 →
 *      上岗零-LLM 干完。期间验证组织机制、零-LLM 铁律、多租户/per-persona 隔离绝不串。
 *
 * 覆盖四条业务线：
 *   A. ADR-0057 按职能进修全闭环 L1→L8（重点）：缺口门(L2)→双老师互审+交叉审(L5/L5b)→影子验收(L4)→
 *      蒸馏门落核(L6)→能力索引(L7)→学完唤醒重跑(L8a)→委派/降级(L8b)→reconciler 兜底(L8c)。
 *   B. 零-LLM 内核运行时铁律（核心论点）：运行时干活/对话/验收全程不调 LLM（只学习期老师是 LLM，由 stub 代）；
 *      companion 零-LLM 对话严格确定性可复现；**已学会执行前后学习账本数量不变=可观测证明运行时未进学习期**。
 *   C. 数字劳动力组织：HTTP 发起组织目标 → 确定性分解 → 委派/执行门（D2 审批/D3 真实执行）。
 *   D. 多租户 + per-persona 隔离（安全底线）：两租户并行，能力索引/学习账本/唤醒绝不跨租户串。
 *
 * 确定性：TestClock + 确定性 idgen + stub 老师（固定 JSON）+ 冻结 ExamSpec/候选 → 同输入同输出可复现。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import { TeacherReviewGate, type Teacher } from '../../intelligence/teacher-review-gate.js';
import { ShadowExamVerifier } from '../../intelligence/shadow-exam-verifier.js';
import { LearningOrchestratorL6 } from '../../intelligence/learning-orchestrator-l6.js';
import { TaskWakeHandler } from '../../workforce/task-wake-handler.js';
import { TaskWakeReconciler } from '../../workforce/task-wake-reconciler.js';
import { CapabilityAssignmentService } from '../../workforce/capability-assignment-service.js';
import { TaskDispositionService } from '../../workforce/task-disposition-service.js';
import {
  EXAM_SCORER_VERSION, EXAM_NORMALIZER_VERSION, EXAM_TOKENIZER_VERSION,
  type ExamSpec, type DistilledArtifact, type LLMProvider, type TeacherVerdict, type TeacherIdentity, type JobFunctionContext,
} from '@chrono/kernel';

/* ── 确定性 fixtures（复用各分片测试同款冻结数据）── */

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
    negativeCases: [{ id: 'n1', answer: '', reason: '空' }, { id: 'n2', answer: '我很厉害', reason: '泛答案' }],
    scorerVersion: EXAM_SCORER_VERSION, normalizerVersion: EXAM_NORMALIZER_VERSION, tokenizerVersion: EXAM_TOKENIZER_VERSION,
  };
}
const GOOD_NARRATIVE = '我是一名研究员，擅长文献检索、综合归纳、引用来源。';
const WEAK_NARRATIVE = '我是一名研究员，擅长文献检索。';  /* 缺两要点 → 影子验收 <95 → 学习失败不落核 */
function narrativeCandidate(narrative: string): DistilledArtifact {
  return {
    id: `dart-${narrative.length}`, kind: 'narrative_patch', source: 'reflection',
    payload: { narrative }, confidence: 0.95, evidence: [{ type: 'test', id: 'e1', score: 1 }],
    status: 'candidate', createdAt: 1000,
  } as DistilledArtifact;
}
const JOB_CTX: JobFunctionContext = { roleCode: 'researcher_ic', jobFamily: 'ic', requiredCapabilities: ['research'] };
const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

/** stub 老师（学习期 LLM 由它确定性代替）：初审返 verdict；交叉审(L5b)返 endorse。零随机。 */
function stubTeacher(reviewVerdict: Partial<TeacherVerdict> = {}, crossEndorse = true, identity: Partial<TeacherIdentity> = {}): Teacher {
  const llm: LLMProvider = {
    async chat(messages) {
      const sys = messages.map((m) => m.content).join('');
      if (sys.includes('TASK:TEACHER_CROSS_REVIEW')) {
        return { content: JSON.stringify({ endorse: crossEndorse, reason: 'still ok' }) };
      }
      return { content: JSON.stringify({ approve: true, reason: 'ok', productivityRelevance: 'high', conflictsWithExisting: false, ...reviewVerdict }) };
    },
    async embed() { return []; },
  };
  return { llm, identity: { providerId: 'p', modelId: 'm', baseUrl: 'u', apiKeyId: 'k', account: 'a', ...identity } };
}
/** 一个租户的 in-process 装配（共享 os.getDatabase()）。 */
interface TenantKit {
  readonly tenantId: string;
  readonly headers: Record<string, string>;
  readonly orgId: string;
  readonly workerIdByRole: ReadonlyMap<string, string>;
  readonly store: OrgWorkforceStore;
  readonly lrStore: LearningRequestStore;
  readonly capIndex: CapabilityIndexStore;
  readonly learning: LearningRequestService;
  /**
   * per-tenant L8a 唤醒处理器（订阅 capability-learned，按本租户唤醒）。
   * 现实里 TenantOSFactory 给每租户独立装配 OS + 唤醒器；本 E2E 用 HTTP 注册的**非 default** 租户，
   * 而 OS 自带的唤醒器只服务 default 租户（L8a 租户绑定），故每个测试租户显式订阅自己的唤醒器（与生产同构）。
   * 对照：L7 CapabilityIndexProjector 是租户无关的（按事件 tenantId 派生 store），故不需 per-tenant 投影器。
   */
  readonly wakeHandler: TaskWakeHandler;
}

describe('真实生命周期深度集成 E2E（HTTP + in-process 混合，四业务线）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let clock: TestClock;
  let idCounter = 0;
  /** 跨用例共享主租户装配（① 建，后续复用）。 */
  let mainKit: TenantKit;

  /** 研究组织 pod：主管 + 两个研究员 IC（IC2 用于委派/隔离对照）。 */
  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '研究主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-mgr', managerRoleCode: null },
      { roleCode: 'ic1', title: '研究员1', jobFamily: 'ic', seniority: 'ic', displayName: 'IC1', personaId: 'p-ic1', managerRoleCode: 'mgr' },
      { roleCode: 'ic2', title: '研究员2', jobFamily: 'ic', seniority: 'ic', displayName: 'IC2', personaId: 'p-ic2', managerRoleCode: 'mgr' },
    ];
  }

  /** 注册一个 admin 租户（首注册=admin）+ bootstrap 组织 → 返回该租户装配。 */
  async function registerTenant(email: string): Promise<TenantKit> {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const store = new OrgWorkforceStore(os.getDatabase(), auth.tenantId);
    const chart = new OrgChartService(store, () => clock.now(), () => `${auth.tenantId}-id-${++idCounter}`);
    const boot = chart.bootstrap('org-1', pod());
    const capIndex = new CapabilityIndexStore(os.getDatabase(), auth.tenantId);
    const lrStore = new LearningRequestStore(os.getDatabase(), auth.tenantId);
    const learning = new LearningRequestService(lrStore, () => clock.now(), () => `lr-${auth.tenantId}-${++idCounter}`, auth.tenantId, capIndex);
    /* per-tenant L8a 唤醒器（订阅 os.bus 的 capability-learned，按本租户唤醒）——与生产 TenantOSFactory 同构。 */
    const wakeHandler = new TaskWakeHandler({ bus: os.bus, store, learning, logger: new SilentLogger(), now: () => clock.now(), tenantId: auth.tenantId });
    wakeHandler.start();
    return { tenantId: auth.tenantId, headers, orgId: 'org-1', workerIdByRole: boot.workerIdByRole, store, lrStore, capIndex, learning, wakeHandler };
  }

  /** 造一个委派给某 IC、需 research 能力、可执行的任务。 */
  function seedResearchTask(kit: TenantKit, assignee: string): string {
    const id = `${kit.tenantId}-task-${++idCounter}`;
    kit.store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: assignee,
      accountableWorkerId: kit.workerIdByRole.get('mgr')!, title: '做一份研究', taskType: 'research',
      status: 'delegated', riskLevel: 'low', allowsToolExecution: true, acceptanceCriteria: '达标',
      requiredCapabilities: ['research'], resultSummary: null, dueAt: null, id,
      createdAt: clock.now(), updatedAt: clock.now(),
    });
    return id;
  }

  /** 经 HTTP /execute 路由触发执行（真实路由：缺口门/风险/审批/真实执行）。 */
  async function httpExecute(kit: TenantKit, taskId: string, workerId: string) {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${kit.orgId}/tasks/${taskId}/execute`, headers: kit.headers,
      payload: { workerId, toolId: 'memory.search', arguments: { query: 'x' } },
    });
    return res;
  }

  /** 完整学习闭环（in-process 深层）：L5 互审(+L5b)→L4 影子验收→L6 蒸馏门落核→发 capability-learned。
   * narrative 含三要点→影子验收≥95 通过；缺要点→<95 退回（学习失败，不落核）。 */
  async function runLearningLoop(kit: TenantKit, personaId: string, crossReview: boolean, narrative = GOOD_NARRATIVE): Promise<boolean> {
    /* 登记一条学习请求（pending）——现实里由缺口门触发；此处显式登记驱动 L6。 */
    const reqId = kit.learning.registerGap({ orgId: 'org-1', personaId, capability: 'research', evidence: 'E2E', priority: 'high' }).request.id;
    const gate = new TeacherReviewGate(
      stubTeacher({}, true, { apiKeyId: 'kA', providerId: 'pA' }),
      stubTeacher({}, true, { apiKeyId: 'kB', providerId: 'pB' }),
      new SilentLogger(), crossReview,
    );
    const verifier = new ShadowExamVerifier(os.getDatabase(), (pid) => os.createShadowCore(pid), () => clock.now(), new SilentLogger());
    const orchestrator = new LearningOrchestratorL6(
      kit.lrStore, gate, verifier, os.distillation, os.bus, () => clock.now(), kit.tenantId, new SilentLogger(),
    );
    const r = await orchestrator.orchestrate({
      learningRequestId: reqId, candidate: narrativeCandidate(narrative), examSpec: researchExam(), jobContext: JOB_CTX,
    });
    return r.ok;
  }

  before(async () => {
    clock = new TestClock(1_000_000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger() });
    os.start();
    const config = loadConfig({
      rateLimit: { max: 100_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      runtime: { recovery: { enabled: false } },
      /* 关掉类人化措辞变化性（ADR-0056）——否则同问轮次确定性轮换措辞，与"零-LLM 同输入同输出"的
       * 确定性断言冲突（变化性是确定性的、按轮次轮换，但响应文本会变）。⑤验的是零-LLM 内核作答确定性。 */
      companion: { variabilityEnabled: false },
    });
    app = await createApp({ os, config });
  });
  after(async () => { await app.close(); os.close(); });

  /* ════════════════════ 业务线 A + C：ADR-0057 全闭环 × 组织执行 ════════════════════ */

  it('① C 组织 + A/L2：HTTP 派活遇能力缺口 → /execute 真实路由返回 learning_required（不硬干，零-LLM）', async () => {
    const t = await registerTenant('e2e-main@test.com');
    mainKit = t;
    const taskId = seedResearchTask(t, t.workerIdByRole.get('ic1')!);

    const res = await httpExecute(t, taskId, t.workerIdByRole.get('ic1')!);
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { kind: string; gaps?: Array<{ capability: string }> };
    assert.equal(data.kind, 'learning_required', '缺 research → 不执行，挂起学习');
    assert.ok(data.gaps?.some((g) => g.capability === 'research'));
    /* 任务被挂起 blocked（缺口门，零-LLM）。 */
    assert.equal(t.store.getTask('org-1', taskId)!.status, 'blocked');
  });

  it('② A/L5+L5b+L4+L6：完整学习闭环（双老师互审+交叉审 → 影子验收≥95 → 蒸馏门落核）→ 主内核真的变', async () => {
    const t = mainKit;
    const before = os.getCore('p-ic1').narrative.get();
    /* 启用 L5b 交叉审第二轮（最严互审）。 */
    const ok = await runLearningLoop(t, 'p-ic1', true);
    assert.equal(ok, true, '学习闭环通过（互审+交叉审+影子验收≥95+落核）');

    /* L6 落核：p-ic1 主内核叙事变成研究员叙事（确定性内核能答研究三要点）。 */
    const after = os.getCore('p-ic1').narrative.get();
    assert.notEqual(after, before, '主内核已落核改变');
    assert.equal(after, GOOD_NARRATIVE);
    /* L7：capability-learned 事件已被投影器写入能力索引（已学正式来源）。 */
    assert.deepEqual(t.capIndex.listLearnedCapabilities('p-ic1'), ['research'], 'L7 能力索引记 research');
    /* L2 账本：passed。 */
    assert.deepEqual(t.lrStore.listPassedCapabilities('p-ic1'), ['research']);
  });

  it('③ A/L8a + C 执行链 + B 零-LLM：学完上岗——L8a 唤醒挂起任务回 delegated → 缺口门放行进入真实执行链', async () => {
    const t = mainKit;
    const ic1 = t.workerIdByRole.get('ic1')!;
    /* ②的 capability-learned 已触发 per-tenant L8a 唤醒 → ①的挂起任务回 delegated（不再 blocked）。 */
    const stillBlocked = t.store.listLearningBlockedTasks('org-1').filter((task) => task.assignedToWorkerId === ic1);
    assert.equal(stillBlocked.length, 0, 'L8a 已唤醒（学完 ①的任务不再 blocked）');

    /* 找回被唤醒的任务（现 delegated）+ 唤醒计数推进（确认确实经 L8a 唤醒而非从未挂起）。 */
    const woken = t.store.listTasksByAssignee('org-1', ic1).find((task) => task.requiredCapabilities.includes('research') && task.status === 'delegated');
    assert.ok(woken, '存在被 L8a 唤醒回 delegated 的任务');
    assert.ok(woken!.resumeAttemptCount >= 1, '任务确经 L8a 唤醒（resumeAttemptCount 推进）');

    /* HTTP /execute 重跑：**关键不变量** = 缺口门已放行（不再 learning_required）→ 进入真实执行链
     * （风险/审批/授权/管线）。下游可能止于 needs_approval（D2）或 denied_authorization（无代理授权书，
     * 测试未播种 agent-auth grant=正常）——但**绝不再是 learning_required**，证明学习闭环解了缺口。 */
    const res = await httpExecute(t, woken!.id, ic1);
    const parsed = JSON.parse(res.body) as { data?: { kind?: string }; code?: string };
    const downstream = parsed.data?.kind ?? parsed.code ?? '';  /* 200 走 data.kind；409 走 error code。 */
    assert.notEqual(downstream, 'learning_required', '学完 → 缺口门放行（不再要求学习）');
    assert.ok(
      downstream === 'needs_approval' || downstream === 'STATE_INVALID_TRANSITION' || downstream === 'executed',
      `学完进入真实执行链（实际 downstream=${downstream}）`,
    );
  });

  it('④ B 零-LLM 铁律：已学会 persona 执行 → 不进学习期（不新增学习请求、缺口门放行），可观测证明运行时零-LLM', async () => {
    const t = mainKit;
    const ic1 = t.workerIdByRole.get('ic1')!;
    /* **可观测断言**（非仪式）：运行时若误进学习期就会经 detectAndRegister 新增/复用学习请求并调老师。
     * 已学会 research 的 p-ic1 执行 research 任务，运行时必须**零-LLM 直接放行**——通过「学习请求账本数量
     * 执行前后不变」可观测证明：缺口门未发现缺口 → 未登记任何学习请求 → 未进入学习期 → 未调老师。 */
    const lrBefore = t.lrStore.listByOrg('org-1').length;

    const taskId = seedResearchTask(t, ic1);
    const res = await httpExecute(t, taskId, ic1);

    /* ① 不新增学习请求（运行时未进学习期）。 */
    const lrAfter = t.lrStore.listByOrg('org-1').length;
    assert.equal(lrAfter, lrBefore, '已学会 → 执行不新增学习请求（运行时未进学习期/未调老师）');
    /* ② 缺口门放行（非 learning_required）；运行时路径不应 5xx（未因误调老师崩）。 */
    assert.ok(res.statusCode < 500, `运行时零-LLM 路径不应 5xx（实际 ${res.statusCode}）: ${res.body}`);
    const parsed = JSON.parse(res.body) as { data?: { kind?: string }; code?: string };
    const kind = parsed.data?.kind ?? parsed.code ?? '';
    assert.notEqual(kind, 'learning_required', '已学会 → 缺口门放行（运行时不调老师，零-LLM）');
  });

  it('⑤ B 零-LLM 对话确定性：companion chat（OfflineConversationResponder）同输入严格同输出可复现', async () => {
    /* companion 零-LLM 对话走 default persona（C 端，无需 workforce auth）。变化性已关 → 同问严格同答
     * （确定性内核作答，无 LLM 无随机）。严格断言两次都 200 且 body 完全相同（不放宽，避免假绿）。 */
    const ask = () => app.inject({ method: 'POST', url: '/api/v1/companion/me/chat', headers: mainKit.headers, payload: { message: '你好，你是谁？' } });
    const r1 = await ask();
    const r2 = await ask();
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(r1.body, r2.body, 'companion 零-LLM 对话严格确定性可复现（同输入同输出）');
    /* 进一步：响应体确有内容（非空回复），证明真走了零-LLM 内核作答而非空壳。 */
    const reply = JSON.parse(r1.body).data as { reply?: string; content?: string };
    assert.ok((reply.reply ?? reply.content ?? '').length > 0, '零-LLM 内核确实作答（非空）');
  });

  /* ════════════════════ 业务线 A：L8b 委派 / L8c reconciler ════════════════════ */

  it('⑥ A/L8b 委派：缺能力者（p-mgr 未学 research）→ disposition 委派给有能力的同事（换人做，任务续，零-LLM）', async () => {
    const t = mainKit;
    /* p-ic1 已学会 research（②）。p-mgr 未学 → 缺口者。委派应换给一个学齐 research 的 active 同事
     * （确定性稳定序选首个；IC1 已会，故 IC1 是合法委派对象）。 */
    const gapWorker = t.workerIdByRole.get('mgr')!;  /* p-mgr 未学 research */
    const ic1Id = t.workerIdByRole.get('ic1')!;
    const taskId = `${t.tenantId}-deleg-${++idCounter}`;
    t.store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: gapWorker,
      accountableWorkerId: gapWorker, title: '委派研究', taskType: 'research', status: 'delegated',
      riskLevel: 'low', allowsToolExecution: true, acceptanceCriteria: '达标', requiredCapabilities: ['research'],
      resultSummary: null, dueAt: null, id: taskId, createdAt: clock.now(), updatedAt: clock.now(),
    });

    const disposition = new TaskDispositionService({
      store: t.store, capabilities: new CapabilityAssignmentService(t.store, t.learning), now: () => clock.now(),
    });
    const d = disposition.dispose({ orgId: 'org-1', task: t.store.getTask('org-1', taskId)!, currentWorkerId: gapWorker, missingCapabilities: ['research'] });
    assert.equal(d.kind, 'delegated', '有会的同事 → 委派');
    /* 委派对象必是真学齐 research 的 active 同事（IC1 已学；稳定序选首个合格者）。 */
    if (d.kind === 'delegated') {
      const delegatedPersona = t.store.getWorker('org-1', d.toWorkerId)!.personaId;
      assert.ok(t.learning.listLearnedCapabilities(delegatedPersona).includes('research'), '委派对象真学齐 research（非踢皮球）');
      assert.equal(d.toWorkerId, ic1Id, '稳定序：首个合格同事 IC1（确定性）');
    }
    assert.notEqual(t.store.getTask('org-1', taskId)!.assignedToWorkerId, gapWorker, '执行者已换给有能力的同事');
  });

  it('⑦ A/L8c reconciler：丢事件（学会但未发 capability-learned）→ 反扫补唤醒（不永久挂起）', async () => {
    const t = mainKit;
    /* 新 persona p-rec 缺 research，任务挂起；学会但**不发事件**（模拟丢投）。 */
    const worker = t.workerIdByRole.get('ic2')!;  /* 复用 IC2 worker，但换 persona 视角不影响：用其 persona */
    /* 直接造一个 blocked + 关联学习请求的任务（reconciler 只反扫学习 blocked）。 */
    const personaId = 'p-ic2';
    const taskId = `${t.tenantId}-rec-${++idCounter}`;
    t.store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: worker, accountableWorkerId: worker,
      title: '反扫研究', taskType: 'research', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: '达标', requiredCapabilities: ['analysis'], resultSummary: null, dueAt: null, id: taskId,
      createdAt: clock.now(), updatedAt: clock.now(),
    });
    /* 登记 analysis 学习请求（关联任务）+ 挂起。 */
    t.learning.registerGap({ orgId: 'org-1', personaId, capability: 'analysis', evidence: 'E2E', priority: 'high', triggeredByTaskId: taskId });
    t.store.transitionTaskExecutionIfStatus('org-1', taskId, 'delegated', 'blocked', '能力缺口待进修：analysis', clock.now());

    /* 学会 analysis 但**不发事件**（丢投）。 */
    t.capIndex.upsert({ id: `ci-${++idCounter}`, personaId, capability: 'analysis', examScore: 0.97, learningRequestId: 'seed', capabilityVersion: 1, learnedAt: clock.now(), updatedAt: clock.now() });

    /* reconciler 反扫 → 复检无缺口 → 补唤醒。 */
    const wakeHandler = new TaskWakeHandler({ bus: os.bus, store: t.store, learning: t.learning, logger: new SilentLogger(), now: () => clock.now(), tenantId: t.tenantId });
    const reconciler = new TaskWakeReconciler({ store: t.store, learning: t.learning, wakeHandler, logger: new SilentLogger(), now: () => clock.now() });
    const stats = reconciler.reconcileOnce('org-1', clock.now());
    assert.ok(stats.woke >= 1, '丢事件也被反扫补唤醒');
    assert.equal(t.store.getTask('org-1', taskId)!.status, 'delegated', '任务已唤醒回 delegated');
  });

  /* ════════════════════ 业务线 D：多租户 + per-persona 隔离 ════════════════════ */

  it('⑧ D 多租户隔离：第二租户并行——能力索引/学习账本/已学绝不跨租户串', async () => {
    const t2 = await registerTenant('e2e-other@test.com');
    /* 第二租户全新——主租户 p-ic1 已学会 research，但 t2 的同名 persona 绝不应"已学"。 */
    assert.deepEqual(t2.capIndex.listLearnedCapabilities('p-ic1'), [], 't2 的 p-ic1 未学 research（不跨租户串）');
    assert.deepEqual(t2.lrStore.listPassedCapabilities('p-ic1'), [], 't2 学习账本不含主租户的 passed');

    /* t2 派 research 任务给 ic1 → 缺口门挡（因 t2 该 persona 真未学）。 */
    const taskId = seedResearchTask(t2, t2.workerIdByRole.get('ic1')!);
    const res = await httpExecute(t2, taskId, t2.workerIdByRole.get('ic1')!);
    const data = JSON.parse(res.body).data as { kind: string };
    assert.equal(data.kind, 'learning_required', 't2 同 persona 仍需自己学（隔离）');

    /* 反向：主租户能力未被 t2 的操作污染。 */
    assert.deepEqual(mainKit.capIndex.listLearnedCapabilities('p-ic1'), ['research'], '主租户 p-ic1 已学不受 t2 影响');
  });

  it('⑨ D per-persona 隔离：同租户不同 persona 各自内核——p-ic1 学会不等于 p-mgr 学会', async () => {
    const t = mainKit;
    /* p-ic1 已学 research（②）；p-mgr 在同租户但未学 → 能力索引按 persona 隔离。 */
    assert.deepEqual(t.capIndex.listLearnedCapabilities('p-ic1'), ['research']);
    assert.deepEqual(t.capIndex.listLearnedCapabilities('p-mgr'), [], 'per-persona：p-mgr 未学 research');
    /* 主内核也 per-persona：p-ic1 叙事 = 研究员；default/p-mgr 不受影响。 */
    assert.equal(os.getCore('p-ic1').narrative.get(), GOOD_NARRATIVE);
    assert.notEqual(os.getCore('p-mgr').narrative.get(), GOOD_NARRATIVE, 'p-mgr 内核未被 p-ic1 的落核污染');
  });

  /* ════════════════════ 现实失败模式：学习失败 / 降级（Codex E2E 复审建议补） ════════════════════ */

  it('⑩ A 失败模式：影子验收 <95（学得不够）→ 学习失败，绝不落核（不假学会）', async () => {
    const t = mainKit;
    /* 全新 persona p-weak 学 research，但候选叙事只含一个要点 → L4 影子验收 <95 → L6 失败不落核。 */
    const before = os.getCore('p-weak').narrative.get();
    const ok = await runLearningLoop(t, 'p-weak', false, WEAK_NARRATIVE);
    assert.equal(ok, false, '影子验收 <95 → 学习失败');
    /* 主内核未被污染（不假学会）；能力索引不记 research。 */
    assert.equal(os.getCore('p-weak').narrative.get(), before, '学习失败 → 主内核不变（不假落核）');
    assert.deepEqual(t.capIndex.listLearnedCapabilities('p-weak'), [], '学习失败 → 能力索引不记 research');
    /* L2 账本：该学习请求标 failed（不是 passed）——真没学会，下次同类仍需学。 */
    assert.deepEqual(t.lrStore.listPassedCapabilities('p-weak'), [], '学习失败 → 无 passed 记录');
  });

  it('⑪ A/L8b 降级：无合格同事 + 允许降级 → submitted + [降级] 标注（有产出但显式不假完成，缺哪块能力可解释）', async () => {
    const t = mainKit;
    /* 全新组织视角：派一个需 'compliance'（无人会）的任务给 p-mgr。无合格同事 → 开启降级 → 标注式降级。 */
    const gapWorker = t.workerIdByRole.get('mgr')!;
    const taskId = `${t.tenantId}-degr-${++idCounter}`;
    t.store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: gapWorker, accountableWorkerId: gapWorker,
      title: '合规审查', taskType: 'compliance', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: '达标', requiredCapabilities: ['compliance'], resultSummary: null, dueAt: null, id: taskId,
      createdAt: clock.now(), updatedAt: clock.now(),
    });
    /* allowDegrade=true（opt-in）。无人会 compliance → 委派失败 → 降级。 */
    const disposition = new TaskDispositionService({
      store: t.store, capabilities: new CapabilityAssignmentService(t.store, t.learning), now: () => clock.now(), allowDegrade: true,
    });
    const d = disposition.dispose({ orgId: 'org-1', task: t.store.getTask('org-1', taskId)!, currentWorkerId: gapWorker, missingCapabilities: ['compliance'] });
    assert.equal(d.kind, 'degraded', '无合格同事 + 允许降级 → 降级');
    const task = t.store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'submitted', '降级 → submitted（有产出不阻塞）');
    assert.match(task.resultSummary!, /\[降级\]/, '结果带 [降级] 标注（显式不假完成）');
    assert.match(task.resultSummary!, /compliance/, '标注缺哪块能力（可解释）');
  });
});
