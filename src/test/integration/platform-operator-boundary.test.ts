/**
 * 审计 P0 回归：平台运营者边界。
 *
 * 交叉审查（Codex）在第一版修复里发现三个问题，本文件逐条锁死：
 *
 *  1. **平台密钥不得成为万能钥匙**。第一版在 jwt-auth 里给持平台密钥的请求塞了
 *     `{tenantId:'default', role:'member'}` 的假租户用户，于是它能以 default
 *     租户成员身份访问**任意**普通端点（如 `/api/v1/audit` 无角色守卫、只看
 *     `request.tenantId`）。现在只在平台端点白名单上认它，且只打能力标记。
 *  2. **`auth.enabled=true` 时必须仍可用**。API-key hook 注册在 jwt-auth
 *     **之前**，若不在那里也识别平台密钥，平台请求会先被「缺少 X-API-Key」401。
 *     第一版的测试把 auth.enabled 留成默认 false，因而漏掉了这个生产组合。
 *  3. **退款端点**（`/api/v1/admin/billing/refund`）此前只认租户 admin，且整条
 *     链无 tenantId，可对平台 Stripe 账户里**任意**已知支付发起退款。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { PLATFORM_OPERATOR_ROUTE_LIST } from '../../server/plugins/platform-operator.js';

const PLATFORM_KEY = 'test-platform-operator-key';
const TENANT_KEY = 'test-tenant-api-key';

describe('审计 P0 — 平台运营者边界（auth.enabled=true 生产组合）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  before(async () => {
    /* ⚠️ auth.enabled=true：API-key hook 会先于 jwt-auth 运行。 */
    const config = loadConfig({
      server: { publicUrl: 'https://example.test' },
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      auth: {
        enabled: true,
        apiKeys: [TENANT_KEY],
        metricsApiKeys: [],
        platformOperatorKeys: [PLATFORM_KEY],
        requireDbKeys: false,
      },
      jwt: { enabled: true, secret: 'x'.repeat(40), issuer: 'test' },
      /* 开 Stripe，否则 refund 路由根本不注册（此前探针 404 就是被这个绊住的）。 */
      stripe: { enabled: true, secretKey: 'sk_test_x', webhookSecret: 'whsec_x', publishableKey: 'pk_x' },
    });
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  after(async () => { await app.close(); os.close(); });

  it('平台端点接受 X-Platform-Key（auth.enabled=true 下不被 API-key hook 401）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { 'x-platform-key': PLATFORM_KEY },
    });
    assert.equal(res.statusCode, 200, `应放行，实际 ${res.statusCode}: ${res.body}`);
  });

  it('平台端点也接受 Authorization: Bearer <平台密钥>', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { authorization: `Bearer ${PLATFORM_KEY}` },
    });
    assert.equal(res.statusCode, 200, `Bearer 形式应放行，实际 ${res.statusCode}`);
  });

  it('平台密钥**不是万能钥匙**：非平台端点一律不放行', async () => {
    /* /api/v1/audit 没有角色守卫、只看 request.tenantId —— 第一版实现下
     * 平台密钥会被当成 default 租户成员，从而读到该租户审计日志。 */
    const audit = await app.inject({
      method: 'GET', url: '/api/v1/audit', headers: { 'x-platform-key': PLATFORM_KEY },
    });
    assert.equal(audit.statusCode, 401, `平台密钥不得访问 /api/v1/audit，实际 ${audit.statusCode}`);

    const portal = await app.inject({
      method: 'POST', url: '/api/v1/billing/portal',
      headers: { 'x-platform-key': PLATFORM_KEY }, payload: { returnUrl: 'https://example.test/back' },
    });
    assert.equal(portal.statusCode, 401, `平台密钥不得为 default 租户开计费门户，实际 ${portal.statusCode}`);
  });

  it('auth.enabled=false 时平台密钥同样不是万能钥匙（jwt-auth 为第一道防线）', async () => {
    /* ⚠️ 这条**必须**单独建 app：上面那条在 auth.enabled=true 下跑，而彼时
     * API-key hook 先于 jwt-auth 执行并直接 401，jwt-auth 里的平台分支根本
     * 走不到 —— 实测「还原成万能钥匙实现」时上面那条依然全绿，**它抓不到这个回归**。
     * auth.enabled=false 才让 jwt-auth 成为第一道，暴露真正的风险面：
     * 变异版下 /api/v1/audit 实测返回 200（读到 default 租户审计日志）。 */
    const cfg = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      auth: {
        enabled: false, apiKeys: [], metricsApiKeys: [],
        platformOperatorKeys: [PLATFORM_KEY], requireDbKeys: false,
      },
      jwt: { enabled: true, secret: 'x'.repeat(40), issuer: 'test' },
    });
    const os2 = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os2.start();
    const app2 = await createApp({ os: os2, config: cfg });
    try {
      const ok = await app2.inject({
        method: 'GET', url: '/api/v1/admin/config', headers: { 'x-platform-key': PLATFORM_KEY },
      });
      assert.equal(ok.statusCode, 200, '平台端点仍应放行');

      const audit = await app2.inject({
        method: 'GET', url: '/api/v1/audit', headers: { 'x-platform-key': PLATFORM_KEY },
      });
      assert.equal(audit.statusCode, 401,
        `平台密钥不得读取租户审计日志，实际 ${audit.statusCode}（万能钥匙实现下这里是 200）`);
    } finally { await app2.close(); os2.close(); }
  });

  it('退款端点：租户 key 被拒（此前可对任意已知支付退款）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/billing/refund',
      headers: { 'x-api-key': TENANT_KEY }, payload: { paymentIntent: 'pi_victim' },
    });
    assert.equal(res.statusCode, 403, `租户 key 必须被拒，实际 ${res.statusCode}: ${res.body}`);
  });

  it('退款端点：平台密钥可通过授权（下游 Stripe 失败与鉴权无关）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/billing/refund',
      headers: { 'x-platform-key': PLATFORM_KEY }, payload: { paymentIntent: 'pi_x' },
    });
    /* 关键是**没有**被 403/401 挡在授权层；用的是假 Stripe key，下游必然失败。 */
    assert.notEqual(res.statusCode, 403, '平台密钥不应被授权层拒绝');
    assert.notEqual(res.statusCode, 401, '平台密钥不应被认证层拒绝');
  });

  it('能力标记不可被客户端污染（body / __proto__ / query / header 均无效）', async () => {
    /* `markPlatformOperator` 往 request 上写 `_platformOperator`，`requirePlatformOperator`
     * 读它就放行。若客户端能通过任意途径把该属性置真，整套守卫即告失效。
     * 逐一实测：body 直塞、body 原型污染、query 参数、同名 header，
     * 以及「原型污染之后再发一个干净请求」（验证无全局残留）。 */
    const attempts: Array<[string, InjectOptions]> = [
      ['body 直塞', { method: 'PATCH', url: '/api/v1/admin/config',
        headers: { 'x-api-key': TENANT_KEY },
        payload: { _platformOperator: true, 'safety.drift.warningThreshold': 0.1 } }],
      ['body 原型污染', { method: 'PATCH', url: '/api/v1/admin/config',
        headers: { 'x-api-key': TENANT_KEY },
        payload: { __proto__: { _platformOperator: true }, 'safety.drift.warningThreshold': 0.1 } }],
      ['query 参数', { method: 'GET', url: '/api/v1/admin/config?_platformOperator=true',
        headers: { 'x-api-key': TENANT_KEY } }],
      ['同名 header', { method: 'GET', url: '/api/v1/admin/config',
        headers: { 'x-api-key': TENANT_KEY, _platformOperator: 'true' } }],
      ['污染后的干净请求', { method: 'GET', url: '/api/v1/admin/config',
        headers: { 'x-api-key': TENANT_KEY } }],
    ];
    for (const [label, opts] of attempts) {
      const res = await app.inject(opts);
      assert.equal(res.statusCode, 403, `${label} 不得绕过平台守卫，实际 ${res.statusCode}`);
    }
    /* 对照：真平台密钥仍然可用（确保上面不是「一律拒绝」的假通过）。 */
    const ok = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { 'x-platform-key': PLATFORM_KEY },
    });
    assert.equal(ok.statusCode, 200, '真平台密钥应仍可用');
  });

  it('⛔ 不变量：白名单每条路由都必须拒绝租户凭据（防「认证放行但无授权守卫」）', async () => {
    /* 这条是**类别级**防线，来自独立审查的建议。
     *
     * 上一版用**路径前缀**做认证判定：`/api/v1/billing/add-ons` 前缀下还挂着
     * `POST /:id/purchase` —— 一个面向租户、**没有任何守卫**的端点。认证层放行了它，
     * 授权层又不在它上面，于是平台密钥 + 任意 X-Tenant-Id 能给**别的租户**写
     * entitlement（实测 200 {"purchased":true}，无凭据同请求 401）。
     *
     * 光修那一条不够——只要「认证白名单」与「实际挂守卫的路由」会漂移，同类缺陷
     * 就会再来。这里对白名单里的**每一条**发一个带租户凭据的请求，断言全部被拒：
     * 若某条只被认证层放行、却没挂 requirePlatformOperator，它就会返回 2xx 而暴露。 */
    for (const r of PLATFORM_OPERATOR_ROUTE_LIST) {
      const url = r.path.replace(':id', 'probe-id');
      const res = await app.inject({
        method: r.method as 'GET', url,
        headers: { 'x-api-key': TENANT_KEY },
        ...(r.method === 'GET' ? {} : { payload: {} }),
      });
      assert.ok(res.statusCode === 403 || res.statusCode === 401,
        `${r.method} ${r.path} 应拒绝租户凭据（401/403），实际 ${res.statusCode}：`
        + `该路由可能在认证白名单里却没挂 requirePlatformOperator`);
    }
  });

  it('租户端点 /add-ons/:id/purchase 不得被平台密钥认证（Critical 回归）', async () => {
    /* 直接锁死那条被利用的路径：它在旧前缀白名单覆盖范围内，但**不是**平台端点。 */
    const res = await app.inject({
      method: 'POST', url: '/api/v1/billing/add-ons/probe-id/purchase',
      headers: { 'x-platform-key': PLATFORM_KEY, 'x-tenant-id': 'victim-tenant' },
    });
    assert.equal(res.statusCode, 401,
      `平台密钥不得认证租户端点，实际 ${res.statusCode}（修复前是 200 {"purchased":true}）`);
  });

  it('白名单是前缀匹配，但不得被相似路径蒙混（config-evil 不是平台端点）', async () => {
    /* `path === p || path.startsWith(p + '/')` —— 校验 `-evil` 这类相似前缀
     * 不会意外落进平台白名单（否则平台密钥会在非平台路径上被认）。 */
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config-evil', headers: { 'x-platform-key': PLATFORM_KEY },
    });
    assert.notEqual(res.statusCode, 200, '相似前缀不得被当作平台端点放行');
  });

  it('JWT 密钥端点：平台密钥可用、租户凭据一律 403（认证绕过链已闭合）', async () => {
    /* 这是整条漏洞链的终点：能轮换全局签名密钥就能伪造任意租户 admin 令牌。 */
    const rotateAsTenant = await app.inject({
      method: 'POST', url: '/api/v1/auth/keys/rotate',
      headers: { 'x-api-key': TENANT_KEY }, payload: { newActiveKid: 'x' },
    });
    assert.equal(rotateAsTenant.statusCode, 403, '租户凭据不得轮换全局密钥');

    const listAsTenant = await app.inject({
      method: 'GET', url: '/api/v1/auth/keys', headers: { 'x-api-key': TENANT_KEY },
    });
    assert.equal(listAsTenant.statusCode, 403, '租户凭据不得查看全局密钥集合');

    const listAsPlatform = await app.inject({
      method: 'GET', url: '/api/v1/auth/keys', headers: { 'x-platform-key': PLATFORM_KEY },
    });
    assert.equal(listAsPlatform.statusCode, 200, '平台密钥应可查看');
  });

  it('出示空 key 不得匹配（防 platformOperatorKeys 配成 [""] 时的意外放行）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { 'x-platform-key': '' },
    });
    assert.notEqual(res.statusCode, 200, '空 key 不得放行');
  });
});
