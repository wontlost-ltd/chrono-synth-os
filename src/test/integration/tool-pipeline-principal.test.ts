/**
 * 工具调用管线是否把**执行主体**传给授权判定（审计 #440-2）。
 *
 * 为什么必须在管线这一层单独测：service 的单测只能证明「判据本身对」，
 * 证明不了「生产路径真的把 principal 传下去了」。把
 * `tool-invocation-pipeline.ts` 里那个实参改回不传（或写死 null），
 * service 单测**照样全绿** —— 这正是本仓记录过的坑（#394：用例直调 kernel
 * 命令绕过了生产调用点，改名后仍全绿）。
 *
 * 故这里走真实 pipeline.invoke()，不碰内部方法。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import type { ToolAdapter } from '../../agent/tool-adapter.js';

const TENANT = 'default';
const PERSONA = 'p_pipeline';
const TOOL_ID = 'probe.act';

describe('工具管线传递执行主体（审计 #440-2）', () => {
  let os: ChronoSynthOS;
  let pipeline: ToolInvocationPipeline;
  let auth: AgencyAuthorizationService;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const db = os.getDatabase();
    const now = Date.now();
    for (const [id, email] of [['u_alice', 'a@e.com'], ['u_bob', 'b@e.com']]) {
      db.prepare<void>(
        `INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(id, email, 'h', 'member', TENANT, now, now);
    }

    /* 低风险工具：不触发 confirmation，让授权判定成为唯一变量。
     * ⚠️ metadata 的键是 `id` 不是 `toolId`——写错会以 undefined 注册，
     * 于是管线在授权判定**之前**就返回 tool_not_found，三条用例全红且
     * 与本次改动无关（我第一版就是这么错的）。故此处不加 as-cast，
     * 让类型检查把字段名钉死。 */
    const adapter: ToolAdapter = {
      metadata: {
        id: TOOL_ID, displayName: 'Probe', description: 'probe tool',
        inputSchema: { type: 'object', properties: {} },
        highRisk: false,
        defaultTimeoutMs: 5_000,
        defaultMaxPerDay: 100,
      },
      async invoke() {
        return { content: [{ type: 'text' as const, text: 'ok' }], costCents: 0, outputSizeBytes: 2 };
      },
    };

    const registry = new ToolRegistry();
    registry.register(adapter);

    auth = new AgencyAuthorizationService(db);
    pipeline = new ToolInvocationPipeline({
      tx: db, registry, logger: new SilentLogger(),
      permissions: new ToolPermissionService(db),
      authorizations: auth,
      confirmationStore: new ConfirmationTokenStore(db),
    });

    /* 工具权限对两人都放开——这样被拒只可能来自授权书层。 */
    new ToolPermissionService(db).grant({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL_ID, scope: 'execute',
      constraints: { maxActionsPerDay: 100 }, grantedBy: 'u_alice',
    });
  });

  afterEach(() => { os.close(); });

  it('★审计 #440-2：Bob 的宽泛授权不得让 Alice 在真实管线里调到该工具★', async () => {
    /* Alice 只授权了别的工具（不含 probe.act）。 */
    auth.create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: 'u_alice',
      scope: 'communication', scopeDescription: 'Alice grants read-only email access only.',
      allowedTools: ['read_email'],
    });
    /* Bob 在同一 persona 上另签一份全权委托。 */
    auth.create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: 'u_bob',
      scope: 'all', scopeDescription: 'Bob grants full delegation for his own workflows.',
    });

    const asAlice = await pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL_ID,
      invokerType: 'org_worker', invokerId: 'u_alice', invokerUserId: 'u_alice',
      arguments: {},
    });

    /* ★核心断言★：变异实测——把管线里的实参改回不传执行主体
     * （或写死 null）→ 本行变 ok=true 转红，即 Alice 借到了 Bob 的授权。 */
    assert.equal(asAlice.ok, false, 'Alice 不得借用 Bob 的授权');
    assert.equal(asAlice.status, 'denied_authorization');

    /* 对照：Bob 用自己的授权可以调 —— 修复不是「把工具关掉」。 */
    const asBob = await pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL_ID,
      invokerType: 'org_worker', invokerId: 'u_bob', invokerUserId: 'u_bob',
      arguments: {},
    });
    assert.equal(asBob.ok, true, 'Bob 用自己签发的授权应放行');
  });

  it('对照：Alice 自己授权了该工具时，真实管线放行', async () => {
    auth.create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: 'u_alice',
      scope: 'communication', scopeDescription: 'Alice grants probe tool access for her workflow.',
      allowedTools: [TOOL_ID],
    });

    const res = await pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL_ID,
      invokerType: 'org_worker', invokerId: 'u_alice', invokerUserId: 'u_alice',
      arguments: {},
    });
    assert.equal(res.ok, true, 'Alice 自己的授权内应放行');
  });

  it('对照：自主调用（invokerUserId 省略）仍放行——不得打断自主运行', async () => {
    auth.create({
      tenantId: TENANT, personaId: PERSONA, principalUserId: 'u_alice',
      scope: 'research', scopeDescription: 'Alice grants autonomous research gig acceptance.',
      allowedTools: [TOOL_ID],
    });

    /* 真实自主路径就是这么调的：invokerType='internal' 且不带 invokerUserId
     * （persona-earning-service.ts / draft-github-reply.ts 明确传 null）。 */
    const res = await pipeline.invoke({
      tenantId: TENANT, personaId: PERSONA, toolId: TOOL_ID,
      invokerType: 'internal', invokerId: 'persona-earning-cycle', invokerUserId: null,
      arguments: {},
    });
    assert.equal(res.ok, true, '自主行动不得被 principal 判据误伤');
  });
});
