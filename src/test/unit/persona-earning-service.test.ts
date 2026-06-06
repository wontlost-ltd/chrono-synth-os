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
import type { DecisionEngine } from '../../intelligence/decision-engine.js';
import type { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';

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

  const decisionEngine = {
    evaluate: async () => ({ caseId: 'c', recommendedAlternative: opts.decision, rankedOptions: [], simulatedAt: 1 }),
  } as unknown as DecisionEngine;

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
});
