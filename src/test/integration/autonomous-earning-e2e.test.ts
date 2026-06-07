/**
 * ADR-0048 端到端：自主挣钱真实跑通（真实 pipeline，非 mock）。
 * 这是 Codex 审查暴露的缺口——之前单测 mock 了 pipeline，掩盖了 marketplace.act
 * highRisk 导致的 confirmation 死锁。本测试用真实 ToolInvocationPipeline +
 * MarketplaceTool + 授权，验证自主 apply 真的成功（不卡在 pending_confirmation）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import { MarketplaceTool } from '../../agent/tools/marketplace-tool.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { InMemoryEmbeddingIndex } from '../../intelligence/embedding-index-memory.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { PersonaEarningService } from '../../intelligence/persona-earning-service.js';

const TENANT = 'default';

describe('Autonomous earning E2E (ADR-0048, real pipeline)', () => {
  let os: ChronoSynthOS;
  let core: PersonaCoreService;
  let earning: PersonaEarningService;
  let ownerId: string;
  let workerPersonaId: string;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const db = os.getDatabase();
    const now = Date.now();
    /* 两个用户：worker owner + 一个 publisher（避免自接自发） */
    db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('u_worker', 'w@e.com', 'h', 'member', TENANT, now, now);
    db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('u_pub', 'p@e.com', 'h', 'member', TENANT, now, now);
    ownerId = 'u_worker';

    core = new PersonaCoreService(db);
    const worker = core.createPersona({ tenantId: TENANT, ownerUserId: ownerId, displayName: 'Worker', profile: { mission: 'research' } });
    workerPersonaId = worker.id;

    /* 授权 + 权限：让 worker persona 可用 marketplace.act（低风险免确认） */
    new AgencyAuthorizationService(db).create({
      tenantId: TENANT, personaId: workerPersonaId, principalUserId: ownerId,
      scope: 'research', scopeDescription: '自主接 research 活', allowedTools: ['marketplace.act'],
    });
    new ToolPermissionService(db).grant({
      tenantId: TENANT, personaId: workerPersonaId, toolId: 'marketplace.act', scope: 'execute',
      constraints: { maxActionsPerDay: 50 }, grantedBy: ownerId,
    });

    /* 真实 pipeline + 真实 MarketplaceTool */
    const registry = new ToolRegistry();
    registry.register(new MarketplaceTool(core));
    const pipeline = new ToolInvocationPipeline({
      tx: db, registry, logger: new SilentLogger(),
      permissions: new ToolPermissionService(db),
      authorizations: new AgencyAuthorizationService(db),
      confirmationStore: new ConfirmationTokenStore(db),
    });

    /* 真实 autonomous DecisionEngine（rule-engine 主路径，不调 LLM） */
    const router = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const decisionEngine = new DecisionEngine(
      os.core,
      new RetrievalService(os.core.memories, new InMemoryEmbeddingIndex(db, os.getClock(), router, 'mock-embed')),
      router, os.getClock(), new SilentLogger(),
      { rollouts: 1, maxOptions: 3 },
      new RuleEngine(os.getClock(), undefined, new SilentLogger()),
    );

    earning = new PersonaEarningService({
      personaCore: core, decisionEngine, pipeline,
      bus: os.bus, clock: os.getClock(), logger: new SilentLogger(),
    });
  });

  afterEach(() => os.close());

  /** 让 worker 在某 category 有完成历史（使 policy 允许自主），返回新发布的同类任务 id */
  function publishResearchTask(reward = 20): string {
    const t = core.publishTask({
      tenantId: TENANT, publisherUserId: 'u_pub',
      title: 'Research gig', description: 'analyze X', category: 'research', reward,
    });
    return t.id;
  }

  it('真实管线下自主 apply 成功（不卡 pending_confirmation）— 死锁已修', async () => {
    /* 先给 worker 制造 research 完成史 + 与 u_pub 合作史，使 policy 判定 autonomous */
    seedCategoryHistory(core, TENANT, ownerId, workerPersonaId, 'u_pub');
    publishResearchTask(20);

    const result = await earning.runEarningCycle({ tenantId: TENANT, personaId: workerPersonaId, ownerUserId: ownerId });

    /* 关键断言：至少一个任务被真正 applied（经真实 pipeline），不是全卡 review/skip */
    assert.ok(result.applied >= 1, `expected ≥1 applied, got ${JSON.stringify(result)}`);
  });

  it('首次 category（无历史）→ 走人工审批，不自动 apply', async () => {
    publishResearchTask(20); /* worker 无 research 完成史 */
    const result = await earning.runEarningCycle({ tenantId: TENANT, personaId: workerPersonaId, ownerUserId: ownerId });
    assert.equal(result.applied, 0);
    assert.ok(result.reviewQueued >= 1);
  });

  it('action 级风险：apply 免确认，submit 需确认（pending_confirmation）', async () => {
    const db = os.getDatabase();
    const registry = new ToolRegistry();
    registry.register(new MarketplaceTool(core));
    const pipeline = new ToolInvocationPipeline({
      tx: db, registry, logger: new SilentLogger(),
      permissions: new ToolPermissionService(db),
      authorizations: new AgencyAuthorizationService(db),
      confirmationStore: new ConfirmationTokenStore(db),
    });
    const taskId = publishResearchTask(20);

    /* apply：低风险，不需 confirmation → 直接成功 */
    const applyRes = await pipeline.invoke({
      tenantId: TENANT, personaId: workerPersonaId, toolId: 'marketplace.act',
      invokerType: 'internal', invokerId: 'test', invokerUserId: null,
      arguments: { action: 'apply', ownerUserId: ownerId, taskId },
    });
    assert.equal(applyRes.ok, true, 'apply 应免确认直接成功');

    /* submit：高风险（对外承诺）→ pipeline 要求确认 */
    const submitRes = await pipeline.invoke({
      tenantId: TENANT, personaId: workerPersonaId, toolId: 'marketplace.act',
      invokerType: 'internal', invokerId: 'test', invokerUserId: null,
      arguments: { action: 'submit', ownerUserId: ownerId, taskId, assignmentId: 'tas_x' },
    });
    assert.equal(submitRes.ok, false, 'submit 应需确认');
    if (!submitRes.ok) assert.equal(submitRes.status, 'pending_confirmation');
  });
});

/** 制造一条已完成的 research 任务历史（worker 接过同 publisher 的活） */
function seedCategoryHistory(core: PersonaCoreService, tenant: string, owner: string, personaId: string, publisher: string): void {
  const t = core.publishTask({ tenantId: tenant, publisherUserId: publisher, title: 'past', description: 'd', category: 'research', reward: 10 });
  core.acceptTask({ tenantId: tenant, ownerUserId: owner, taskId: t.id, personaId });
  core.completeTask({ tenantId: tenant, ownerUserId: owner, taskId: t.id, qualityScore: 0.9, ownerTrainingHours: 0 });
}
