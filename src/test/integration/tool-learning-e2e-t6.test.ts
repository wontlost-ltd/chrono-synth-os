/**
 * ADR-0060 T6 端到端接线：新工具走完全链（真实 SQLite + EventBus + 执行 pipeline）。
 *
 * 证明 ADR-0060 三层分离全链真正贯通、且红线成立——以 invoice.issue 为例：
 *   ① 学技能 + 门控学习（T3）：候选参数映射规则过 provenance/lint/工具考试 → 落 tool_action_rules；
 *   ② eligibility 建议（T4）：capability-learned → ToolEligibilityProjector 产出授权建议（不 grant）；
 *   ③ 授权（T5）：ToolAutoAuthorizationBridge + 治理白名单 → 白名单低险自动授予 ToolPermission；
 *   ④ 参数编译（T1）：ToolActionCompilerService 据规则从任务字段确定性构造 ToolCallPlan（运行时零-LLM）；
 *   ⑤ 执行：编译出的 arguments 过 ToolInvocationPipeline 全 7 门（含刚授予的 ToolPermission）→ 真正调用工具。
 *
 * 红线端到端验证：
 *   - 高风险工具即便学会+有 eligibility，也不自动授权（T5 只建待审批）→ 执行被 denied_permission（三层分离守住）；
 *   - 运行时零-LLM：④ 参数编译纯确定性（同任务字段 → 同 arguments，可复现）；
 *   - eligibility≠allow：执行门查的是 ToolPermission，不是 eligibility 表。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../../agent/tool-adapter.js';
import { ToolActionRuleStore } from '../../storage/tool-action-rule-store.js';
import { ToolAuthorizationRequestStore } from '../../storage/tool-authorization-request-store.js';
import { CapabilityToolEligibilityStore } from '../../storage/capability-tool-eligibility-store.js';
import { PersonaGovernanceStore } from '../../storage/persona-governance-store.js';
import { ToolActionCompilerService } from '../../intelligence/tool-action-compiler-service.js';
import { ToolRuleLearningService, type CandidateToolRule } from '../../intelligence/tool-rule-learning-service.js';
import { ToolEligibilityProjector } from '../../intelligence/tool-eligibility-projector.js';
import { ToolAutoAuthorizationBridge } from '../../intelligence/tool-auto-authorization-bridge.js';
import type { McpToolSchema, ToolExamSpec } from '@chrono/kernel';

const TENANT = 'tenant-e2e';
const PERSONA = 'agent-1';
const PRINCIPAL = 'user-owner';
const CAP = 'invoicing';
/* 注入时钟须与执行 pipeline 的真实 Date.now() 对齐——pipeline 用 wall-clock 校验 ToolPermission/授权书有效期，
 * 若用远古固定 NOW 会让 grant 的 expiresAt（NOW+TTL）落在 1970，真实 now 下已过期 → denied_permission 假失败。
 * NOW 在每个 beforeEach 刷新为真实 Date.now()（就近取值 + 分钟级 TTL，杜绝 CI 挂起跨过 TTL 的 flaky）。 */
let NOW = 0;
/* 授权/建议有效期取分钟级——远大于任何单测执行时长，防 CI 慢时误过期（Codex T6 复审补 flaky 防护）。 */
const GRANT_TTL_MS = 30 * 60 * 1000;
const ELIGIBILITY_TTL_MS = 60 * 60 * 1000;

/** invoice.issue 工具 inputSchema。 */
const SCHEMA: McpToolSchema = { type: 'object', properties: { customer: {}, currency: {}, action: {} }, required: ['customer', 'currency', 'action'] };

/** 记录收到 arguments 的 stub invoice 工具。 */
class InvoiceTool implements ToolAdapter {
  lastArgs: Record<string, unknown> | null = null;
  constructor(private readonly toolId: string, private readonly highRisk: boolean) {}
  get metadata() {
    return { id: this.toolId, displayName: 'Invoice', description: '开票', inputSchema: SCHEMA, highRisk: this.highRisk, defaultTimeoutMs: 5000, defaultMaxPerDay: 100 };
  }
  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    this.lastArgs = ctx.arguments;
    return { content: [{ type: 'text', text: 'issued' }], costCents: 0, outputSizeBytes: 8 };
  }
}

function candidate(toolId: string, riskClass: 'high' | 'low'): CandidateToolRule {
  return {
    personaId: PERSONA, toolId, capability: CAP,
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

describe('T6 ADR-0060 端到端接线：新工具学→考→编译→建议→授权→执行全链', () => {
  let db: IDatabase;
  let bus: EventBus;
  let registry: ToolRegistry;
  let permissions: ToolPermissionService;
  let learning: ToolRuleLearningService;
  let projector: ToolEligibilityProjector;
  let bridge: ToolAutoAuthorizationBridge;
  let compiler: ToolActionCompilerService;
  let pipeline: ToolInvocationPipeline;
  let lowTool: InvoiceTool;
  let highTool: InvoiceTool;

  beforeEach(() => {
    NOW = Date.now();
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    bus = new EventBus();
    registry = new ToolRegistry();
    lowTool = new InvoiceTool('invoice.issue', false);
    highTool = new InvoiceTool('invoice.pay', true);
    registry.register(lowTool);
    registry.register(highTool);
    permissions = new ToolPermissionService(db);
    learning = new ToolRuleLearningService(new ToolActionRuleStore(db, TENANT), db, () => NOW);
    projector = new ToolEligibilityProjector({ bus, db, logger: new SilentLogger(), now: () => NOW, ttlMs: ELIGIBILITY_TTL_MS });
    projector.start();
    bridge = new ToolAutoAuthorizationBridge({ db, permissions, registry, logger: new SilentLogger(), tenantId: TENANT, now: () => NOW });
    compiler = new ToolActionCompilerService(new ToolActionRuleStore(db, TENANT), TENANT, () => NOW);
    pipeline = new ToolInvocationPipeline({
      tx: db, registry, logger: new SilentLogger(), permissions,
      authorizations: new AgencyAuthorizationService(db),
      confirmationStore: new ConfirmationTokenStore(db),
    });
  });

  afterEach(() => db.close());

  /** ①②：学技能门控落规则 + 触发 eligibility 投影。 */
  function learnAndProject(toolId: string, riskClass: 'high' | 'low'): void {
    assert.ok(learning.learn(candidate(toolId, riskClass), exam(toolId), SCHEMA).ok, `learn ${toolId}`);
    bus.emit('capability-learned', { tenantId: TENANT, personaId: PERSONA, capability: CAP, learningRequestId: 'lr', examScore: 1, learnedAt: NOW } as never);
  }

  it('★全链贯通：低风险白名单工具 学→考→编译→建议→授权→真正执行★', async () => {
    /* ①② 学 + 投影 eligibility。 */
    learnAndProject('invoice.issue', 'low');
    /* ② 显式验证 eligibility 建议真落表（T4 证据）：只建议不 grant，红线 11 元数据齐全。 */
    const elig = new CapabilityToolEligibilityStore(db, TENANT).listActive(PERSONA);
    assert.equal(elig.length, 1, 'eligibility 建议产出');
    assert.equal(elig[0].toolId, 'invoice.issue');
    assert.equal(elig[0].riskClass, 'low');
    assert.equal(elig[0].examSpecVersion, 'texam-invoice.issue::tool-exam-v1', '考试溯源');
    assert.ok(elig[0].expiresAt !== null && elig[0].expiresAt > NOW, '建议带未来有效期');

    /* ③ 授权前置：AgencyAuthorization（法律层委托）——桥只授 ToolPermission，代理授权书仍需（真实场景人工/onboarding）。 */
    new AgencyAuthorizationService(db).create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: PRINCIPAL,
      scope: 'finance', scopeDescription: 'e2e', allowedTools: ['invoice.issue'],
    });
    /* ③ 治理白名单 + 桥自动授予 ToolPermission。 */
    new PersonaGovernanceStore(db, TENANT).upsert(PERSONA, { toolAutoAuthWhitelist: { 'invoice.issue': { scope: 'any', maxExpiryMs: GRANT_TTL_MS, requireConfirmation: false } } }, 'owner', NOW);
    const authRes = bridge.run(PERSONA, PRINCIPAL);
    assert.equal(authRes.granted.length, 1, '白名单低险自动授予');
    assert.equal(authRes.granted[0].toolId, 'invoice.issue');

    /* ④ 参数编译（运行时零-LLM）：任务字段 → 确定性 ToolCallPlan。 */
    const plan = compiler.compile({ personaId: PERSONA, toolId: 'invoice.issue', capability: CAP, toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan.ok, true, '规则编译成功');
    if (!plan.ok) return;
    assert.deepEqual(plan.plan.arguments, { action: 'draft', currency: 'USD', customer: 'Acme' });
    /* 确定性可复现：同任务字段再编译 → 同 arguments + 同幂等键。 */
    const plan2 = compiler.compile({ personaId: PERSONA, toolId: 'invoice.issue', capability: CAP, toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan2.ok, true);
    if (plan2.ok) assert.equal(plan2.plan.idempotencyKey, plan.plan.idempotencyKey, '零-LLM 确定性：幂等键可复现');

    /* ⑤ 执行：编译出的 arguments 过全 7 门（含刚授予的 ToolPermission）→ 真正调用工具。 */
    const result = await pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: 'invoice.issue',
      invokerType: 'internal', invokerId: 'e2e', invokerUserId: null,
      arguments: plan.plan.arguments,
    });
    assert.equal(result.ok, true, '全 7 门通过 → 执行成功');
    assert.deepEqual(lowTool.lastArgs, { action: 'draft', currency: 'USD', customer: 'Acme' }, '工具真正收到编译出的 arguments');
  });

  it('★红线三层分离：高风险工具学会+有 eligibility，但不自动授权 → 执行被拒（denied_permission）★', async () => {
    learnAndProject('invoice.pay', 'high');
    /* 法律层授权书给了（allowedTools 含），但 T5 桥不自动授 ToolPermission（高风险即便白名单也只建待审批）。 */
    new AgencyAuthorizationService(db).create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: PRINCIPAL,
      scope: 'finance', scopeDescription: 'e2e', allowedTools: ['invoice.pay'],
    });
    new PersonaGovernanceStore(db, TENANT).upsert(PERSONA, { toolAutoAuthWhitelist: { 'invoice.pay': { scope: 'any', maxExpiryMs: GRANT_TTL_MS } } }, 'owner', NOW);
    const authRes = bridge.run(PERSONA, PRINCIPAL);
    assert.equal(authRes.granted.length, 0, '高风险不自动授予 ToolPermission');
    assert.equal(new ToolAuthorizationRequestStore(db, TENANT).listPending(PERSONA).length, 1, '只建待审批请求（红线 3）');

    /* 规则能编译（会做），但无 ToolPermission → 执行被拒（三层分离：会做≠被授权做）。 */
    const plan = compiler.compile({ personaId: PERSONA, toolId: 'invoice.pay', capability: CAP, toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan.ok, true, '会正确构造参数（capability 层）');
    if (!plan.ok) return;
    const result = await pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: 'invoice.pay',
      invokerType: 'internal', invokerId: 'e2e', invokerUserId: null,
      arguments: plan.plan.arguments,
    });
    assert.equal(result.ok, false, '无 ToolPermission → 执行被拒');
    if (!result.ok) assert.equal(result.status, 'denied_permission', '正是权限门拒（非授权门/其他）');
    assert.equal(highTool.lastArgs, null, '工具从未被调用');
  });
});
