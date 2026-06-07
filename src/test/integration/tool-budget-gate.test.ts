/**
 * ADR-0048 前置：tool-invocation-pipeline budget gate 集成测试。
 * 之前 budgetLimitCents 仅在文档里、代码从不 enforce（死闸门）。本测试验证：
 * 当日累计工具成本达到 budgetLimitCents 后，后续调用被 denied_budget 拒绝。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { SilentLogger } from '../../utils/index.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../../agent/tool-adapter.js';

const TENANT = 'default';
const PERSONA = 'p1';
const TOOL = 'paid_tool';
const PRINCIPAL = 'user_owner';

/** 每次调用计 10¢ 的 stub 工具 */
class PaidStubTool implements ToolAdapter {
  readonly metadata = {
    id: TOOL,
    displayName: 'Paid Stub',
    description: 'costs 10 cents per call',
    inputSchema: { type: 'object' as const, properties: {} },
    highRisk: false,
    defaultTimeoutMs: 5000,
    defaultMaxPerDay: 1000,
  };
  async invoke(_ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    return { content: [{ type: 'text', text: 'ok' }], costCents: 10, outputSizeBytes: 2 };
  }
}

describe('Tool budget gate (ADR-0048 前置)', () => {
  let db: IDatabase;
  let pipeline: ToolInvocationPipeline;
  let perms: ToolPermissionService;

  function grantWithBudget(budgetLimitCents: number): void {
    const auth = new AgencyAuthorizationService(db);
    auth.create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: PRINCIPAL,
      scope: 'research', scopeDescription: 'test', allowedTools: [TOOL],
    });
    perms.grant({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL, scope: 'execute',
      constraints: { budgetLimitCents },
      grantedBy: PRINCIPAL,
    });
  }

  function invoke() {
    return pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL,
      invokerType: 'internal', invokerId: 'earning-cycle', invokerUserId: null,
      arguments: {},
    });
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const registry = new ToolRegistry();
    registry.register(new PaidStubTool());
    perms = new ToolPermissionService(db);
    pipeline = new ToolInvocationPipeline({
      tx: db, registry, logger: new SilentLogger(), permissions: perms,
      authorizations: new AgencyAuthorizationService(db),
      confirmationStore: new ConfirmationTokenStore(db),
    });
  });

  afterEach(() => db.close());

  it('预算内：调用成功并累计成本', async () => {
    grantWithBudget(100); /* 100¢ 预算 */
    const r = await invoke();
    assert.equal(r.ok, true);
    assert.equal(perms.dailyCostCents(TENANT, PERSONA, TOOL), 10);
  });

  it('累计成本达到预算上限后：后续调用被 denied_budget 拒绝', async () => {
    grantWithBudget(25); /* 25¢ 预算，每次 10¢ */
    assert.equal((await invoke()).ok, true);   /* spent 10, 10<25 ok */
    assert.equal((await invoke()).ok, true);   /* spent 20, 20<25 ok */
    const third = await invoke();               /* spent 20≥? no: 20<25 仍 ok，调用后 30 */
    assert.equal(third.ok, true);
    /* 现在已花 30 ≥ 25 → 下一次必拒 */
    const denied = await invoke();
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.status, 'denied_budget');
  });

  it('budgetLimitCents=0：第一次调用即被拒（零预算）', async () => {
    grantWithBudget(0);
    const r = await invoke();
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 'denied_budget');
  });

  it('未设 budgetLimitCents：不限预算（gate 不触发）', async () => {
    const auth = new AgencyAuthorizationService(db);
    auth.create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: PRINCIPAL,
      scope: 'research', scopeDescription: 'test', allowedTools: [TOOL],
    });
    perms.grant({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL, scope: 'execute',
      constraints: {}, /* 无 budgetLimitCents */
      grantedBy: PRINCIPAL,
    });
    for (let i = 0; i < 5; i++) assert.equal((await invoke()).ok, true);
  });
});
