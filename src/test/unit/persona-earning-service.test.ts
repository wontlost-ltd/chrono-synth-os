/**
 * ADR-0048：PersonaEarningService 编排单元测试（mock 依赖隔离决策分支）。
 * 验证：自接自发跳过、forbidden 不申请、needs_human_review 入队、autonomous+accept 经
 * 管线申请、管线拦截则不计 applied、提现不在路径。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { PersonaEarningService } from '../../intelligence/persona-earning-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { AutonomousDecisionEngine } from '../../intelligence/decision-engine.js';
import type { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import { DEFAULT_EARNING_POLICY } from '@chrono/kernel';

const OWNER = 'user_owner';
const PERSONA = 'p1';

function mkTask(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'mkt_1', tenantId: 'default', publisherUserId: 'pub_other',
    assigneePersonaId: null, assigneeForkId: null, assigneePersonaName: null,
    title: 'Research task', description: 'D', category: 'research', reward: 20, currency: 'CRED',
    status: 'open', qualityScore: null, growthDelta: null,
    publishedAt: 1, acceptedAt: null, completedAt: null, createdAt: 1, updatedAt: 1,
    ...over,
  };
}

interface Harness {
  svc: PersonaEarningService;
  applyCalls: number;
  reviewEvents: number;
}

function harness(opts: {
  openTasks: Record<string, unknown>[];
  decision: string;           /* DecisionEngine recommendedAlternative */
  pipelineOk?: boolean;       /* pipeline.invoke 结果 */
  personaActive?: boolean;
}): Harness {
  let applyCalls = 0;
  let reviewEvents = 0;
  const bus = new EventBus();
  bus.on('system:earning-review-requested', () => { reviewEvents++; });

  /* 历史：已完成 1 个 research 任务 + 与 pub_other 合作过 → 该 category 已熟悉、publisher 非新，
   * 使默认 research 任务可走 autonomous（首次 category / 新 publisher 会升 medium）。 */
  const history = [{
    id: 'mkt_hist', category: 'research', status: 'completed',
    assigneePersonaId: PERSONA, publisherUserId: 'pub_other', reward: 10,
  }];
  const personaCore = {
    getPersonaDetail: () => opts.personaActive === false ? null : ({
      id: PERSONA, status: 'active', reputation: 10, marketplaceTasks: history,
    }),
    listMarketplaceTasks: () => opts.openTasks,
  } as unknown as PersonaCoreService;

  /* F8：earning 依赖窄接口 AutonomousDecisionEngine，只暴露确定性 evaluateAutonomous（同步、零 LLM）。 */
  const decisionEngine = {
    evaluateAutonomous: () => ({ caseId: 'c', recommendedAlternative: opts.decision, rankedOptions: [], simulatedAt: 1 }),
  } as unknown as AutonomousDecisionEngine;

  const pipeline = {
    invoke: async (req: { arguments: { action: string } }) => {
      if (req.arguments.action === 'apply') applyCalls++;
      return opts.pipelineOk === false
        ? { ok: false, invocationId: 'i', status: 'denied_permission', reason: 'no authz' }
        : { ok: true, invocationId: 'i', result: { content: [], costCents: 0, outputSizeBytes: 0 } };
    },
  } as unknown as ToolInvocationPipeline;

  const svc = new PersonaEarningService({
    personaCore, decisionEngine, pipeline, bus, clock: new TestClock(1000), logger: new SilentLogger(),
  });
  return { svc, get applyCalls() { return applyCalls; }, get reviewEvents() { return reviewEvents; } };
}

const input = { tenantId: 'default', personaId: PERSONA, ownerUserId: OWNER };

describe('PersonaEarningService (ADR-0048)', () => {
  it('autonomous 准入 + accept 决策 → 经管线申请', async () => {
    const h = harness({ openTasks: [mkTask()], decision: '接受任务' });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.applied, 1);
    assert.equal(h.applyCalls, 1);
    assert.equal(r.outcomes[0].decision, 'applied');
  });

  it('自接自发 → 跳过（不申请）', async () => {
    const h = harness({ openTasks: [mkTask({ publisherUserId: OWNER })], decision: '接受任务' });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.applied, 0);
    assert.equal(h.applyCalls, 0);
    assert.equal(r.outcomes[0].decision, 'skipped');
    assert.match(r.outcomes[0].reasons.join(), /self-published/);
  });

  it('未授权 category（high 风险）→ needs_human_review，不申请，发审批事件', async () => {
    const h = harness({ openTasks: [mkTask({ category: 'coding' })], decision: '接受任务' });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.reviewQueued, 1);
    assert.equal(h.applyCalls, 0);
    assert.equal(h.reviewEvents, 1);
    assert.equal(r.outcomes[0].decision, 'needs_human_review');
  });

  it('决策 skip → 跳过', async () => {
    const h = harness({ openTasks: [mkTask()], decision: '跳过任务' });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.skipped, 1);
    assert.equal(h.applyCalls, 0);
  });

  it('决策请人工复核 → needs_human_review', async () => {
    const h = harness({ openTasks: [mkTask()], decision: '请人工复核' });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.reviewQueued, 1);
    assert.equal(h.applyCalls, 0);
  });

  it('管线拦截 apply（治理刹车）→ 不计 applied', async () => {
    const h = harness({ openTasks: [mkTask()], decision: '接受任务', pipelineOk: false });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.applied, 0);
    assert.equal(h.applyCalls, 1); /* 尝试了但被拦 */
    assert.match(r.outcomes[0].reasons.join(), /governance brake/);
  });

  it('persona 非 active → 空周期', async () => {
    const h = harness({ openTasks: [mkTask()], decision: '接受任务', personaActive: false });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.scanned, 0);
    assert.equal(r.applied, 0);
  });

  it('近期连续失败达熔断阈值 → forbidden（真实失败史，非硬编码 0）', async () => {
    /* 历史：2 个 cancelled 任务（连续失败 2 ≥ breaker 2）→ 准入 forbidden */
    const failHistory = [
      { id: 'h1', category: 'research', status: 'cancelled', assigneePersonaId: PERSONA, publisherUserId: 'pub_x', reward: 10, updatedAt: 200 },
      { id: 'h2', category: 'research', status: 'cancelled', assigneePersonaId: PERSONA, publisherUserId: 'pub_x', reward: 10, updatedAt: 100 },
    ];
    const h = harnessWithHistory({ openTasks: [mkTask()], decision: '接受任务', history: failHistory });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.applied, 0);
    assert.match(JSON.stringify(r.outcomes), /failure streak|forbidden/);
  });

  it('publisher 高取消率 → AML forbidden', async () => {
    /* 与 pub_aml 4 个任务、3 个 cancelled（取消率 75%>50%）→ AML 拦截 */
    const amlHistory = [
      { id: 'a1', category: 'research', status: 'cancelled', assigneePersonaId: PERSONA, publisherUserId: 'pub_aml', reward: 10, updatedAt: 400 },
      { id: 'a2', category: 'research', status: 'cancelled', assigneePersonaId: PERSONA, publisherUserId: 'pub_aml', reward: 10, updatedAt: 300 },
      { id: 'a3', category: 'research', status: 'cancelled', assigneePersonaId: PERSONA, publisherUserId: 'pub_aml', reward: 10, updatedAt: 200 },
      { id: 'a4', category: 'research', status: 'completed', qualityScore: 0.9, assigneePersonaId: PERSONA, publisherUserId: 'pub_aml', reward: 10, updatedAt: 100 },
    ];
    const h = harnessWithHistory({ openTasks: [mkTask({ publisherUserId: 'pub_aml' })], decision: '接受任务', history: amlHistory });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.applied, 0);
    assert.match(JSON.stringify(r.outcomes), /AML/);
  });

  it('AML 聚合 guard 接线：单 publisher 窗口内接单速率过高 → forbidden（ADR-0048 余项）', async () => {
    /* 窗口内已与 pub_wash 接了 4 单（accepted，在 24h 窗口内）+ 候选第 5 单 → 速率 5≥5 触发聚合 guard。
     * 各单不同额、无取消（绕开旧的取消率 guard），证明拦截来自新的聚合 guard。 */
    const washHistory = [
      { id: 'w1', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_wash', reward: 10, acceptedAt: 900, updatedAt: 400 },
      { id: 'w2', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_wash', reward: 11, acceptedAt: 900, updatedAt: 300 },
      { id: 'w3', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_wash', reward: 12, acceptedAt: 900, updatedAt: 200 },
      { id: 'w4', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_wash', reward: 13, acceptedAt: 900, updatedAt: 100 },
    ];
    const h = harnessWithHistory({ openTasks: [mkTask({ publisherUserId: 'pub_wash' })], decision: '接受任务', history: washHistory });
    const r = await h.svc.runEarningCycle(input);
    assert.equal(r.applied, 0, '聚合 guard 应拦下，不接单');
    assert.match(JSON.stringify(r.outcomes), /接单速率过高/, '拦截原因来自聚合 guard');
  });

  it('AML 聚合 guard 不误伤：正常单 publisher 少量接单 → 放行', async () => {
    /* 窗口内与 pub_ok 只接过 1 单 + 候选 1 单 → 远低于所有聚合阈值，应正常接单（不被新 guard 误拦）。 */
    const okHistory = [
      { id: 'ok1', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_ok', reward: 10, acceptedAt: 900, updatedAt: 100 },
    ];
    const h = harnessWithHistory({ openTasks: [mkTask({ publisherUserId: 'pub_ok' })], decision: '接受任务', history: okHistory });
    const r = await h.svc.runEarningCycle(input);
    assert.ok(!JSON.stringify(r.outcomes).includes('接单速率过高'), '正常收入不应被聚合 guard 拦');
  });

  it('AML 聚合 guard 同周期累积：同 publisher 多 open 单在一个 cycle 内连续接，达阈值后被拦（Codex 复审 High）', async () => {
    /* 历史窗口已有 pub_burst 2 单（accepted）；本 cycle 又有 4 个 pub_burst 的 open 单。
     * 接第 3 个 open 单时窗口累计=2历史+2本轮已接+候选=5 ≥ 阈值 → 速率拦截。证明本轮已接的单被并入窗口，
     * 不是每次都看旧快照（修复前的 bug：4 个都能逐个通过）。需放宽并发上限让多单可接。 */
    const burstHistory = [
      /* 一条很久以前完成的 research 单（别的 publisher，acceptedAt 在 24h 窗口外）→ 让 category 已熟悉
       * （categoryCompletedCount>0，避免「首次接该 category」把决策降级到 needs_human_review），
       * 且不进 AML 窗口（acceptedAt=0 远早于窗口起点）。 */
      { id: 'fam', category: 'research', status: 'completed', qualityScore: 0.9, assigneePersonaId: PERSONA, publisherUserId: 'pub_fam', reward: 5, acceptedAt: 0, updatedAt: 50 },
      { id: 'b1', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_burst', reward: 5, acceptedAt: 900, updatedAt: 200 },
      { id: 'b2', category: 'research', status: 'accepted', assigneePersonaId: PERSONA, publisherUserId: 'pub_burst', reward: 6, acceptedAt: 900, updatedAt: 100 },
    ];
    const openBurst = [
      mkTask({ id: 'o1', publisherUserId: 'pub_burst', reward: 7 }),
      mkTask({ id: 'o2', publisherUserId: 'pub_burst', reward: 8 }),
      mkTask({ id: 'o3', publisherUserId: 'pub_burst', reward: 9 }),
      mkTask({ id: 'o4', publisherUserId: 'pub_burst', reward: 10 }),
    ];
    /* 放宽并发上限，否则 openTaskCount/maxConcurrentTasks 会先于 AML 拦下。 */
    const loosePolicy = { ...DEFAULT_EARNING_POLICY, maxConcurrentTasks: 100 };
    const h = harnessWithHistory({ openTasks: openBurst, decision: '接受任务', history: burstHistory });
    const r = await h.svc.runEarningCycle({ ...input, maxTasksPerCycle: 4, policy: loosePolicy });
    /* 前两单接成功（窗口 2→3→4），第三单时 4+候选=5≥5 → 被拦；至少一单 forbidden 且原因是速率。 */
    assert.ok(r.applied >= 1 && r.applied < 4, `应接了部分单后被拦，实测 applied=${r.applied}`);
    assert.match(JSON.stringify(r.outcomes), /接单速率过高/, '同周期累积达阈值后应被速率信号拦');
  });
});

/* 带任务历史的 harness（用于失败熔断/AML 测试） */
function harnessWithHistory(opts: { openTasks: Record<string, unknown>[]; decision: string; history: Record<string, unknown>[] }): Harness {
  let applyCalls = 0;
  let reviewEvents = 0;
  const bus = new EventBus();
  bus.on('system:earning-review-requested', () => { reviewEvents++; });
  const personaCore = {
    getPersonaDetail: () => ({ id: PERSONA, status: 'active', reputation: 10, marketplaceTasks: opts.history }),
    listMarketplaceTasks: () => opts.openTasks,
  } as unknown as PersonaCoreService;
  /* F8：earning 依赖窄接口 AutonomousDecisionEngine，只暴露确定性 evaluateAutonomous（同步、零 LLM）。 */
  const decisionEngine = {
    evaluateAutonomous: () => ({ caseId: 'c', recommendedAlternative: opts.decision, rankedOptions: [], simulatedAt: 1 }),
  } as unknown as AutonomousDecisionEngine;
  const pipeline = {
    invoke: async (req: { arguments: { action: string } }) => {
      if (req.arguments.action === 'apply') applyCalls++;
      return { ok: true, invocationId: 'i', result: { content: [], costCents: 0, outputSizeBytes: 0 } };
    },
  } as unknown as ToolInvocationPipeline;
  const svc = new PersonaEarningService({ personaCore, decisionEngine, pipeline, bus, clock: new TestClock(1000), logger: new SilentLogger() });
  return { svc, get applyCalls() { return applyCalls; }, get reviewEvents() { return reviewEvents; } };
}
