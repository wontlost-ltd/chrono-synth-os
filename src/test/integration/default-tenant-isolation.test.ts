/**
 * 审计 Critical 回归：`default` 租户必须与其它租户隔离。
 *
 * ## 缺陷
 *
 * 全仓 25 处 `tenantId !== 'default'` 分支把 `default` 请求**绕开 TenantOSFactory**，
 * 直接用宿主根 OS —— 而根 OS 的 db 是**未包装的裸库**。于是：
 *
 *   - 静态 API Key 被强绑 `default`（`auth.ts` 的「防 X-Tenant-Id 伪造」逻辑）
 *   - 持该 key 的请求走裸库 → **看得到所有租户的行**
 *
 * 实测（修复前）：租户 B 用 JWT 建了一条 value，持静态 key 的请求
 * `GET /api/v1/values` **能看到它**。
 *
 * ## 为什么修法是「让 default 也走工厂」
 *
 * `TenantDatabase` 对 `DEFAULT_TENANT` 的豁免**只在 INSERT 值校验**那一处
 * （`tenant-database.ts`，全文件仅此一处），**不影响 SELECT 重写**。
 * 实测：绑定 `default` 的包装器读 `core_values` 只看到自己的行。
 * 所以让 `default` 也经工厂拿到 `TenantDatabase`，读路径立即隔离。
 *
 * ## ⚠️ 本文件必须同时钉死「没有过度修正」
 *
 * 只断言「看不到别人的」是不够的 —— 把所有人都变成看不到任何东西，那条断言
 * 同样会通过。故必须同时断言：租户看得到自己的、`default` 也看得到自己的。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

const STATIC_KEY = 'static-default-bound-key';

describe('审计 Critical — default 租户隔离', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let tenantAuth: Record<string, string>;

  before(async () => {
    const config = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      /* 静态 API Key 会被 auth 插件强绑 default —— 这正是攻击入口。 */
      auth: { enabled: true, apiKeys: [STATIC_KEY], metricsApiKeys: [], requireDbKeys: false },
      jwt: { enabled: true, secret: 'x'.repeat(40), issuer: 'test' },
    });
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });

    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'isolation-tenant@test.com', password: 'password123' },
    });
    assert.ok(reg.statusCode >= 200 && reg.statusCode < 300, `register: ${reg.statusCode} ${reg.body}`);
    tenantAuth = { authorization: `Bearer ${JSON.parse(reg.body).data.accessToken as string}` };

    /* 真租户建一条只属于它的数据。 */
    const created = await app.inject({
      method: 'POST', url: '/api/v1/values', headers: tenantAuth,
      payload: { label: 'tenant-only-secret', weight: 0.9 },
    });
    assert.ok(created.statusCode >= 200 && created.statusCode < 300, `create value: ${created.body}`);
  });

  after(async () => { await app.close(); os.close(); });

  it('绑定 default 的静态 API Key 看不到其它租户的数据（修复前能看到）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/values', headers: { 'x-api-key': STATIC_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes('tenant-only-secret'),
      `default 不得看到其它租户的 value，实际响应：${res.body.slice(0, 200)}`);
  });

  it('对照一：租户仍看得到**自己**的数据（防「谁都看不到」的假修复）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/values', headers: tenantAuth });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('tenant-only-secret'), '租户必须仍能读到自己的数据');
  });

  it('对照二：default 自身的读写仍然可用（它是合法租户，不是被禁用）', async () => {
    const write = await app.inject({
      method: 'POST', url: '/api/v1/values', headers: { 'x-api-key': STATIC_KEY },
      payload: { label: 'default-own-value', weight: 0.5 },
    });
    assert.ok(write.statusCode >= 200 && write.statusCode < 300, `default 写入应成功: ${write.body}`);

    const read = await app.inject({
      method: 'GET', url: '/api/v1/values', headers: { 'x-api-key': STATIC_KEY },
    });
    assert.ok(read.body.includes('default-own-value'), 'default 必须读得回自己刚写的数据');
  });
});
