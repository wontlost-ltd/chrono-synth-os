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
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

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

  it('出示空 key 不得匹配（防 platformOperatorKeys 配成 [""] 时的意外放行）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { 'x-platform-key': '' },
    });
    assert.notEqual(res.statusCode, 200, '空 key 不得放行');
  });
});
