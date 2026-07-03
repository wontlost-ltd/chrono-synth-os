/**
 * 集成测试：ADR-0060 T7 工具自动授权运营 API（owner-only）。
 *
 * POST /run（据资格自动授权）、GET /pending（待审批列表）、POST /requests/:id/decide（决议）。
 * 证明：run 白名单低险自动授 ToolPermission + 非白名单/高险建待审批；pending 列出；decide 转移状态 +
 * 幂等/越权守卫；owner 门控（非 owner/异 user → 404）；错误映射（已决议 → 409-ish state）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import { realClock } from '../../utils/clock.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../../agent/tool-adapter.js';
import { ToolActionRuleStore } from '../../storage/tool-action-rule-store.js';
import { PersonaGovernanceStore } from '../../storage/persona-governance-store.js';
import { ToolRuleLearningService, type CandidateToolRule } from '../../intelligence/tool-rule-learning-service.js';
import { ToolEligibilityProjector } from '../../intelligence/tool-eligibility-projector.js';
import { registerToolAutoAuthorizationRoutes } from '../../server/routes/tool-auto-authorization.js';
import { registerErrorHandler } from '../../server/plugins/error-handler.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { McpToolSchema, ToolExamSpec } from '@chrono/kernel';

const OWNED = 'persona_owned';
const CAP = 'invoicing';
const NOW = Date.now();
const SCHEMA: McpToolSchema = { type: 'object', properties: { customer: {}, currency: {}, action: {} }, required: ['customer', 'currency', 'action'] };

function stubPersonaCore(): PersonaCoreService {
  return {
    getPersonaDetail: (_t: string, ownerUserId: string, personaId: string) =>
      ownerUserId === 'user_1' && personaId === OWNED ? { id: OWNED, marketplaceTasks: [] } : null,
  } as unknown as PersonaCoreService;
}

function stubTool(id: string, highRisk: boolean): ToolAdapter {
  return {
    metadata: { id, displayName: id, description: 't', inputSchema: SCHEMA, highRisk, defaultTimeoutMs: 5000, defaultMaxPerDay: 100 },
    async invoke(_ctx: ToolInvocationContext): Promise<ToolInvocationResult> { return { content: [{ type: 'text', text: 'ok' }], costCents: 0, outputSizeBytes: 2 }; },
  };
}

function candidate(toolId: string, riskClass: 'high' | 'low'): CandidateToolRule {
  return {
    personaId: OWNED, toolId, capability: CAP,
    schemaVersion: 'v1', ruleVersion: 'r1', contentHash: `h-${toolId}`, createdBy: 'teacher', expiresAt: null,
    sourceArtifactId: `artifact-${toolId}`, riskClass,
    argMappings: {
      customer: { kind: 'pick', field: 'customerName' },
      currency: { kind: 'enum', field: 'ccy', allow: ['USD', 'EUR'] },
      action: { kind: 'const', value: 'draft' },
    },
  };
}

function exam(toolId: string): ToolExamSpec {
  return {
    examId: `texam-${toolId}`, toolId, capability: CAP, schemaVersion: 'v1', scorerVersion: 'tool-exam-v1',
    cases: [
      { id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } },
      { id: 'bad', kind: 'expect_fail', taskFields: { customerName: 'Acme', ccy: 'JPY' }, expectFailCodes: ['enum_violation'] },
    ],
  };
}

async function buildApp(db: IDatabase, registry: ToolRegistry, user: { sub: string } = { sub: 'user_1' }): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const app = fastify();
  registerErrorHandler(app);
  app.addHook('onRequest', async (req) => {
    (req as { user?: unknown }).user = { sub: user.sub, planId: 'free', role: 'user' };
    (req as { tenantId?: string }).tenantId = 'default';
  });
  registerToolAutoAuthorizationRoutes(app, {
    db, registry, personaCore: stubPersonaCore(), logger: new SilentLogger(), clock: realClock,
  });
  await app.ready();
  return app;
}

describe('ADR-0060 T7 工具自动授权运营 API（owner-only）', () => {
  let db: IDatabase;
  let bus: EventBus;
  let registry: ToolRegistry;
  let app: FastifyInstance;

  /** 学一条规则 + 投影 eligibility。 */
  function learnAndProject(toolId: string, riskClass: 'high' | 'low'): void {
    const learning = new ToolRuleLearningService(new ToolActionRuleStore(db, 'default'), db, () => NOW);
    assert.ok(learning.learn(candidate(toolId, riskClass), exam(toolId), SCHEMA).ok, `learn ${toolId}`);
    bus.emit('capability-learned', { tenantId: 'default', personaId: OWNED, capability: CAP, learningRequestId: 'lr', examScore: 1, learnedAt: NOW } as never);
  }

  function whitelist(entries: Record<string, { scope: 'read' | 'write' | 'any'; maxExpiryMs: number }>): void {
    new PersonaGovernanceStore(db, 'default').upsert(OWNED, { toolAutoAuthWhitelist: entries }, 'user_1', NOW);
  }

  beforeEach(async () => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    bus = new EventBus();
    registry = new ToolRegistry();
    registry.register(stubTool('tool.low', false));
    registry.register(stubTool('tool.high', true));
    const projector = new ToolEligibilityProjector({ bus, db, logger: new SilentLogger(), now: () => NOW, ttlMs: 60 * 60 * 1000 });
    projector.start();
    app = await buildApp(db, registry);
  });
  afterEach(async () => { await app.close(); db.close(); });

  it('POST /run：白名单低险 → 授 ToolPermission；非白名单/高险 → 建待审批', async () => {
    learnAndProject('tool.low', 'low');
    learnAndProject('tool.high', 'high');
    whitelist({ 'tool.low': { scope: 'read', maxExpiryMs: 30 * 60 * 1000 } });
    const res = await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/run` });
    assert.equal(res.statusCode, 200, res.body);
    const { data } = res.json();
    assert.equal(data.granted.length, 1, '白名单低险授予 1');
    assert.equal(data.granted[0].toolId, 'tool.low');
    assert.equal(data.requested.length, 1, '高险建待审批 1');
    assert.equal(data.requested[0].toolId, 'tool.high');
    /* 授予真落库：check 放行。 */
    const perm = new ToolPermissionService(db).check({ tenantId: 'default', personaId: OWNED, toolId: 'tool.low', now: NOW + 1 });
    assert.equal(perm.allowed, true);
  });

  it('GET /pending：列出待审批请求', async () => {
    learnAndProject('tool.high', 'high');
    await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/run` });
    const res = await app.inject({ method: 'GET', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/pending` });
    assert.equal(res.statusCode, 200, res.body);
    const { data } = res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].toolId, 'tool.high');
    assert.equal(data[0].reason, 'high_risk');
    assert.equal(data[0].status, 'pending');
  });

  it('POST /decide：approve 一条请求 → 转 approved，不再 pending', async () => {
    learnAndProject('tool.high', 'high');
    await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/run` });
    const pending = (await app.inject({ method: 'GET', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/pending` })).json().data;
    const reqId = pending[0].id;
    const res = await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/requests/${reqId}/decide`, payload: { decision: 'approved' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.decision, 'approved');
    /* 决议后不再 pending。 */
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/pending` })).json().data.length, 0);
    /* approved 不等于授予 ToolPermission（红线 3：真正授权仍需 owner 显式 grant）。 */
    const perm = new ToolPermissionService(db).check({ tenantId: 'default', personaId: OWNED, toolId: 'tool.high', now: NOW + 1 });
    assert.equal(perm.allowed, false, 'approve 不自动授权');
  });

  it('POST /decide：非法 decision → 400；不存在的 requestId → 404', async () => {
    learnAndProject('tool.high', 'high');
    await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/run` });
    const bad = await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/requests/x/decide`, payload: { decision: 'maybe' } });
    assert.equal(bad.statusCode, 400, bad.body);
    const missing = await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/requests/nope/decide`, payload: { decision: 'approved' } });
    assert.equal(missing.statusCode, 404, missing.body);
  });

  it('POST /decide：重复决议 → 冲突（pending→终态后不可再决议）', async () => {
    learnAndProject('tool.high', 'high');
    await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/run` });
    const reqId = (await app.inject({ method: 'GET', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/pending` })).json().data[0].id;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/requests/${reqId}/decide`, payload: { decision: 'approved' } })).statusCode, 200);
    /* 再决议：已不 pending → 404（belongs 检查先拦）。 */
    const again = await app.inject({ method: 'POST', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/requests/${reqId}/decide`, payload: { decision: 'rejected' } });
    assert.equal(again.statusCode, 404, again.body);
  });

  it('owner 门控：非 owner persona → 404', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/persona-core/not_owned/tool-auto-auth/run` });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('owner 门控：异 user → 404', async () => {
    const other = await buildApp(db, registry, { sub: 'user_2' });
    const res = await other.inject({ method: 'GET', url: `/api/v1/persona-core/${OWNED}/tool-auto-auth/pending` });
    assert.equal(res.statusCode, 404, res.body);
    await other.close();
  });
});
