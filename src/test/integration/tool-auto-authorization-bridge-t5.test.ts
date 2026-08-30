/**
 * ADR-0060 T5 集成：ToolAutoAuthorizationBridge 端到端（真实 SQLite）。
 *
 * 验证低风险白名单自动授权桥据有效 eligibility 建议决策：
 *   - 白名单 + 低风险 → 自动授予 ToolPermission（expiresAt 非空且不超白名单上限）；
 *   - 非白名单 / 高风险 → 不自动授权，建待审批请求（红线 3）；
 *   - 幂等：重复运行不重复建 pending；
 *   - 红线 11：陈旧建议（工具 schema/risk 变、过期）不被授权（listValidForAuthorization fail-closed）；
 *   - 红线 13：「低风险」只看治理白名单，不看 tool.metadata.highRisk 自证。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../../agent/tool-adapter.js';
import { ToolActionRuleStore } from '../../storage/tool-action-rule-store.js';
import { ToolAuthorizationRequestStore } from '../../storage/tool-authorization-request-store.js';
import { PersonaGovernanceStore } from '../../storage/persona-governance-store.js';
import { ToolRuleLearningService, type CandidateToolRule } from '../../intelligence/tool-rule-learning-service.js';
import { ToolEligibilityProjector } from '../../intelligence/tool-eligibility-projector.js';
import { ToolAutoAuthorizationBridge } from '../../intelligence/tool-auto-authorization-bridge.js';
import type { McpToolSchema, ToolExamSpec } from '@chrono/kernel';

const TENANT = 'tenant-a';
const PERSONA = 'p1';
const NOW = 1_000_000;

const SCHEMA: McpToolSchema = { type: 'object', properties: { customer: {}, currency: {}, action: {} }, required: ['customer', 'currency', 'action'] };

/** 低风险 stub 工具（metadata.highRisk=false）。 */
function stubTool(id: string, highRisk: boolean): ToolAdapter {
  return {
    metadata: { id, displayName: id, description: 't', inputSchema: SCHEMA, highRisk, defaultTimeoutMs: 5000, defaultMaxPerDay: 100 },
    async invoke(_ctx: ToolInvocationContext): Promise<ToolInvocationResult> { return { content: [{ type: 'text', text: 'ok' }], costCents: 0, outputSizeBytes: 2 }; },
  };
}

function candidate(toolId: string, riskClass: 'high' | 'low', over: Partial<CandidateToolRule> = {}): CandidateToolRule {
  return {
    personaId: PERSONA, toolId, capability: 'invoicing',
    schemaVersion: 'v1', ruleVersion: 'r1', contentHash: `h-${toolId}`, createdBy: 'teacher', expiresAt: null,
    sourceArtifactId: `artifact-${toolId}`, riskClass,
    argMappings: {
      customer: { kind: 'pick', field: 'customerName' },
      currency: { kind: 'enum', field: 'ccy', allow: ['USD', 'EUR'] },
      action: { kind: 'const', value: 'draft' },
    },
    ...over,
  };
}

function exam(toolId: string): ToolExamSpec {
  return {
    examId: `texam-${toolId}`, toolId, capability: 'invoicing', schemaVersion: 'v1', scorerVersion: 'tool-exam-v1',
    cases: [
      { id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } },
      { id: 'bad', kind: 'expect_fail', taskFields: { customerName: 'Acme', ccy: 'JPY' }, expectFailCodes: ['enum_violation'] },
    ],
  };
}

describe('T5 ADR-0060 工具自动授权桥（真实 SQLite）', () => {
  let db: IDatabase;
  let bus: EventBus;
  let registry: ToolRegistry;
  let permissions: ToolPermissionService;
  let learning: ToolRuleLearningService;
  let projector: ToolEligibilityProjector;
  let bridge: ToolAutoAuthorizationBridge;
  let requestStore: ToolAuthorizationRequestStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    bus = new EventBus();
    registry = new ToolRegistry();
    registry.register(stubTool('tool.low', false));
    registry.register(stubTool('tool.high', true));
    permissions = new ToolPermissionService(db);
    learning = new ToolRuleLearningService(new ToolActionRuleStore(db, TENANT), db, () => NOW);
    projector = new ToolEligibilityProjector({ bus, db, logger: new SilentLogger(), now: () => NOW, ttlMs: 100_000 });
    projector.start();
    bridge = new ToolAutoAuthorizationBridge({ db, permissions, registry, logger: new SilentLogger(), tenantId: TENANT, now: () => NOW });
    requestStore = new ToolAuthorizationRequestStore(db, TENANT);
  });

  /** 学一条规则并触发 eligibility 投影。 */
  function learnAndProject(toolId: string, riskClass: 'high' | 'low', over: Partial<CandidateToolRule> = {}): void {
    assert.ok(learning.learn(candidate(toolId, riskClass, over), exam(toolId), SCHEMA).ok, `learn ${toolId}`);
    bus.emit('capability-learned', { tenantId: TENANT, personaId: PERSONA, capability: 'invoicing', learningRequestId: 'lr', examScore: 1, learnedAt: NOW } as never);
  }

  /** 设治理白名单。 */
  function whitelist(entries: Record<string, { scope: 'read' | 'write' | 'any'; maxExpiryMs: number }>): void {
    new PersonaGovernanceStore(db, TENANT).upsert(PERSONA, { toolAutoAuthWhitelist: entries }, 'owner', NOW);
  }

  it('★白名单 + 低风险 → 自动授予 ToolPermission（expiresAt 非空、不超白名单上限）★', () => {
    learnAndProject('tool.low', 'low');
    whitelist({ 'tool.low': { scope: 'read', maxExpiryMs: 50_000 } });
    const res = bridge.run(PERSONA, 'owner');
    assert.equal(res.granted.length, 1, '授予 1 条');
    assert.equal(res.granted[0].toolId, 'tool.low');
    assert.equal(res.granted[0].expiresAt, NOW + 50_000, 'expiresAt = now + 白名单上限（<建议 100k 余量）');
    assert.equal(res.requested.length, 0);
    /* 权限真落库可校验。 */
    const check = permissions.check({ tenantId: TENANT, personaId: PERSONA, toolId: 'tool.low', now: NOW + 1 });
    assert.equal(check.allowed, true, '授予后 permission check 放行');
  });

  it('★非白名单 → 不授权，建待审批请求（红线 3）★', () => {
    learnAndProject('tool.low', 'low');
    /* 空白名单 → 低风险也不自动授权。 */
    const res = bridge.run(PERSONA, 'owner');
    assert.equal(res.granted.length, 0);
    assert.equal(res.requested.length, 1);
    assert.equal(res.requested[0].reason, 'not_whitelisted');
    assert.equal(requestStore.listPending(PERSONA).length, 1);
  });

  it('★高风险即便在白名单 → 不授权，建待审批（reason=high_risk，红线 3/13）★', () => {
    learnAndProject('tool.high', 'high');
    whitelist({ 'tool.high': { scope: 'any', maxExpiryMs: 50_000 } });
    const res = bridge.run(PERSONA, 'owner');
    assert.equal(res.granted.length, 0, '高风险不自动授予（即便白名单）');
    assert.equal(res.requested.length, 1);
    assert.equal(res.requested[0].reason, 'high_risk');
  });

  it('★幂等：重复运行不重复建 pending 请求★', () => {
    learnAndProject('tool.low', 'low');
    assert.equal(bridge.run(PERSONA, 'owner').requested.length, 1, '首次建请求');
    const second = bridge.run(PERSONA, 'owner');
    assert.equal(second.requested.length, 0, '二次不重复建');
    assert.equal(second.skipped.length, 1, '已 pending 跳过');
    assert.equal(requestStore.listPending(PERSONA).length, 1, 'pending 仍单条');
  });

  it('★红线 11：工具 schema 变化 → 建议陈旧不授权（也不建请求，因 listValidForAuthorization 已排除）★', () => {
    /* 学的规则 schemaVersion=v1；注册表把 tool.low 的 schemaVersion 声明为 v2 → 陈旧失效。 */
    learnAndProject('tool.low', 'low');
    whitelist({ 'tool.low': { scope: 'read', maxExpiryMs: 50_000 } });
    const bumped = new ToolRegistry();
    bumped.register({ ...stubTool('tool.low', false), metadata: { ...stubTool('tool.low', false).metadata, schemaVersion: 'v2' } });
    const staleBridge = new ToolAutoAuthorizationBridge({ db, permissions, registry: bumped, logger: new SilentLogger(), tenantId: TENANT, now: () => NOW });
    const res = staleBridge.run(PERSONA, 'owner');
    assert.equal(res.granted.length, 0, 'schema 变 → 不授权');
    assert.equal(res.requested.length, 0, '陈旧建议根本不进决策（fail-closed 排除）');
  });

  it('★红线 11：过期建议 → 不授权★', () => {
    learnAndProject('tool.low', 'low');
    whitelist({ 'tool.low': { scope: 'read', maxExpiryMs: 50_000 } });
    /* now 推到建议 expiresAt（NOW+100k）之后 → 过期失效。 */
    const expiredBridge = new ToolAutoAuthorizationBridge({ db, permissions, registry, logger: new SilentLogger(), tenantId: TENANT, now: () => NOW + 200_000 });
    const res = expiredBridge.run(PERSONA, 'owner');
    assert.equal(res.granted.length, 0);
    assert.equal(res.requested.length, 0);
  });

  it('决议 pending 请求（approve/reject）幂等转移', () => {
    learnAndProject('tool.low', 'low');
    bridge.run(PERSONA, 'owner');
    const pending = requestStore.listPending(PERSONA);
    assert.equal(pending.length, 1);
    assert.equal(requestStore.decide(pending[0].id, 'approved', 'admin', NOW + 1), true, '首次决议成功');
    assert.equal(requestStore.decide(pending[0].id, 'rejected', 'admin', NOW + 2), false, '已决议不可再决议（防重复）');
    assert.equal(requestStore.listPending(PERSONA).length, 0, 'approved 后不再 pending');
  });

  /* ── 审计 #440-4d：computeGrantExpiry 「无 now 下界」被记为潜伏风险 ──
   *
   * 担心的是：若 `eligibilityExpiresAt` 已在过去，`Math.min(now + cap, 它)`
   * 会算出一个**已经过期**的 expiresAt，等于授予了一条立刻失效（或更糟，
   * 被别处当成永久）的权限。
   *
   * 复核结论：**不可达**。授权前置的
   * `CapabilityToolEligibilityStore.listValidForAuthorization` 里有一句
   * `if (e.expiresAt === null || now >= e.expiresAt) return false;`
   * —— 已过期的建议在进入 computeGrantExpiry **之前**就被 fail-closed 掉了。
   *
   * 故这不是「潜伏缺陷」而是**误报**。但「靠上游过滤保证」的不变量值得钉住，
   * 免得日后有人放宽那道过滤时无声破坏这里。 */
  it('审计 #440-4d：授予的 expiresAt 恒 > now（过期建议在上游已被 fail-closed）', () => {
    learnAndProject('tool.low', 'low');
    whitelist({ 'tool.low': { scope: 'read', maxExpiryMs: 50_000 } });

    /* 把建议有效期直接改到**过去**，模拟陈旧 eligibility。 */
    db.prepare<void>(
      `UPDATE capability_tool_eligibility SET expires_at = ?
       WHERE tenant_id = ? AND persona_id = ? AND tool_id = ?`,
    ).run(NOW - 1, TENANT, PERSONA, 'tool.low');

    const res = bridge.run(PERSONA, 'owner');

    /* 变异实测：把 listValidForAuthorization 的 `now >= e.expiresAt` 判据
     * 去掉 → 这里会授予一条 expiresAt = NOW-1 的权限，下面两行转红。 */
    assert.equal(res.granted.length, 0, '过期建议不得进入授予路径');
    for (const g of res.granted) {
      assert.ok(g.expiresAt > NOW, `授予的 expiresAt 必须晚于 now（实际 ${g.expiresAt}）`);
    }
  });

  /* 对照：未过期的建议照常授予 —— 防止「把功能一起关掉」也算绿。
   * ⚠️ 必须复用已注册的 `tool.low`：注册表里只有 tool.low / tool.high，
   * 用别的 id 会命中「工具已下线 fail-closed」而非本用例要测的过期逻辑
   * （我第一版用 tool.low2，红在这里，与 expiresAt 无关）。 */
  it('对照：#440-4d 未过期建议仍正常授予', () => {
    learnAndProject('tool.low', 'low');
    whitelist({ 'tool.low': { scope: 'read', maxExpiryMs: 50_000 } });
    const res = bridge.run(PERSONA, 'owner');
    assert.equal(res.granted.length, 1, '未过期建议应授予');
    assert.ok(res.granted[0].expiresAt > NOW, 'expiresAt 恒 > now');
  });
});
