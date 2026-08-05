/**
 * 集成测试：GitHub App 安装入口产品化（admin 凭据端点 + setup 回调）。
 *
 * 断言重点：
 *   1. **私钥绝不回显**（安全铁律）——响应体不含私钥任何片段；
 *   2. **回调必须已登录**（首要安全不变量）——未登录 401；租户取自会话而非 URL 参数，
 *      否则任何人构造 ?installation_id=<他人的> 就能把别人的 installation 绑到自己租户，
 *      进而用自己的会话读取他人组织的 GitHub 内容；
 *   3. DELETE 断开连接后 GET 返 configured:false。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake0123456789\n-----END RSA PRIVATE KEY-----';

describe('GitHub 安装入口（admin 凭据端点 + setup 回调）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const config = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      encryption: {
        enabled: true, masterKey: randomBytes(32).toString('base64'),
        defaultKeyRef: 'master', keyring: {}, keyRotationIntervalDays: 90,
      },
    });
    app = await createApp({ os, config });
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'gh-admin@test.com', password: 'password123' },
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('POST 录凭据 → GET 返 configured:true 且响应体绝不含私钥', async () => {
    const post = await app.inject({
      method: 'POST', url: '/api/v1/admin/github/app', headers,
      payload: { appId: '123456', privateKeyPem: FAKE_PEM, webhookSecret: 'whsec_test' },
    });
    assert.equal(post.statusCode, 200, post.body);
    assert.ok(!post.body.includes('PRIVATE KEY'), 'POST 响应不得回显私钥');

    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    assert.equal(get.statusCode, 200, get.body);
    const data = JSON.parse(get.body).data as { configured: boolean; appId?: string };
    assert.equal(data.configured, true);
    assert.equal(data.appId, '123456');
    /* 安全铁律：私钥绝不回显——整个响应体不得含 PEM 任何片段。 */
    assert.ok(!get.body.includes('PRIVATE KEY'), 'GET 响应不得含私钥');
    assert.ok(!get.body.includes('MIIEfake'), 'GET 响应不得含私钥内容');
  });

  it('未配置时 GET 返 configured:false', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    assert.equal(get.statusCode, 200, get.body);
    assert.equal((JSON.parse(get.body).data as { configured: boolean }).configured, false);
  });

  it('DELETE 断开连接 → GET 返 configured:false', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/admin/github/app', headers,
      payload: { appId: '123456', privateKeyPem: FAKE_PEM, webhookSecret: 'whsec_test' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/admin/github/app', headers });
    assert.equal(del.statusCode, 200, del.body);

    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    assert.equal((JSON.parse(get.body).data as { configured: boolean }).configured, false);
  });

  it('安全不变量：setup 回调未登录 → 401（绝不允许匿名绑定 installation）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/github/setup?installation_id=999&setup_action=install',
      /* 刻意不带 authorization 头。 */
    });
    assert.equal(res.statusCode, 401, `未登录回调必须 401，实际 ${res.statusCode}：${res.body.slice(0, 160)}`);
  });

  it('setup 回调已登录 → 映射记到**会话租户**（而非 URL 参数推断）', async () => {
    /* 先录凭据（GET 状态端点需 configured 才返 installations 列表）。 */
    await app.inject({
      method: 'POST', url: '/api/v1/admin/github/app', headers,
      payload: { appId: '123456', privateKeyPem: FAKE_PEM, webhookSecret: 'whsec_test' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/github/setup?installation_id=777&setup_action=install',
      headers,
    });
    assert.equal(res.statusCode, 200, res.body);

    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    const data = JSON.parse(get.body).data as { installations: Array<{ installationId: string }> };
    assert.ok(
      data.installations.some((i) => i.installationId === '777'),
      `回调应把 installation 记到会话租户下，实际 ${JSON.stringify(data.installations)}`,
    );
  });

  it('setup 回调缺 installation_id → 4xx（不静默成功）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/integrations/github/setup?setup_action=install', headers,
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `缺参应 4xx，实际 ${res.statusCode}`);
  });
});
