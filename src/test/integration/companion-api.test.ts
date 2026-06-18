/**
 * 集成测试：ChronoCompanion C 端 API（ADR-0046 Phase 2.1）。
 *
 * 覆盖：
 *  - GET /api/v1/companion/me 正常路径（注册用户 → 200 + 契约形状 + 看到自己写入的价值/记忆/叙事）
 *  - GET /api/v1/companion/me/growth 空态（无基线快照 → hasBaseline=false，drift 不报错）
 *  - plan 门控：enterprise 账号 → 403（companion 面向个人版）
 *  - 未授权 → 401/403
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
  CompanionMemoryListV1Schema,
} from '@chrono/contracts';
import { ProactiveMessageStore } from '../../storage/proactive-message-store.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

async function registerAndGetAuth(
  app: FastifyInstance,
  email: string,
): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string; userId: string };
}

describe('ChronoCompanion C 端 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('GET /companion/me 返回数字人主页（含写入的价值/记忆/叙事）', async () => {
    const auth = await registerAndGetAuth(app, 'companion-me@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* 通过真实写路径播种数据（与 token 同租户） */
    await app.inject({ method: 'POST', url: '/api/v1/values', headers, payload: { label: '好奇心', weight: 0.9 } });
    await app.inject({ method: 'POST', url: '/api/v1/values', headers, payload: { label: '稳定', weight: 0.3 } });
    await app.inject({
      method: 'POST', url: '/api/v1/memories', headers,
      payload: { kind: 'episodic', content: '第一次和你聊天', valence: 0.5, salience: 0.8 },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 200, res.body);
    /* 私有数据缓存头：no-store + Vary（防 HTTP/SW/CDN 跨会话复用） */
    assert.match(String(res.headers['cache-control']), /private/);
    assert.match(String(res.headers['cache-control']), /no-store/);
    assert.match(String(res.headers['vary']), /Authorization/i);
    const body = JSON.parse(res.body).data;
    /* 用契约 schema 反向校验：后端输出严格符合前端类型 */
    const me = CompanionMeV1Schema.parse(body);

    assert.equal(me.valueCount, 2);
    assert.equal(me.memoryCount, 1);
    /* topValues 按 weight 降序 */
    assert.equal(me.topValues[0].label, '好奇心');
    assert.equal(me.topValues[1].label, '稳定');
    assert.equal(me.recentMemories[0].content, '第一次和你聊天');
  });

  it('GET /companion/me/growth 无基线 → 空态而非报错', async () => {
    const auth = await registerAndGetAuth(app, 'companion-growth@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me/growth', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['cache-control']), /no-store/);
    const growth = CompanionGrowthV1Schema.parse(JSON.parse(res.body).data);
    assert.equal(growth.hasBaseline, false);
    assert.equal(growth.overallIntensity, 'steady');
    assert.deepEqual(growth.directions, []);
  });

  it('GET /companion/me/growth 单快照 → hasBaseline=false（单快照不算历史基线）', async () => {
    const auth = await registerAndGetAuth(app, 'companion-onesnap@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* 制造恰好 1 个快照：countTenantSnapshots=1 < 2 → 无可对比基线 */
    const snap = await app.inject({
      method: 'POST', url: '/api/v1/snapshots', headers, payload: { reason: 'manual' },
    });
    assert.equal(snap.statusCode, 201, snap.body);

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me/growth', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['cache-control']), /no-store/);
    const growth = CompanionGrowthV1Schema.parse(JSON.parse(res.body).data);
    assert.equal(growth.hasBaseline, false, '单快照不应被判为有基线');
    assert.deepEqual(growth.directions, []);
  });

  it('GET /companion/me/memories 分页浏览记忆（含 pagination 元信息）', async () => {
    const auth = await registerAndGetAuth(app, 'companion-mems@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* 写 3 条记忆 */
    for (const content of ['第一段记忆', '第二段记忆', '第三段记忆']) {
      const r = await app.inject({
        method: 'POST', url: '/api/v1/memories', headers,
        payload: { kind: 'episodic', content, valence: 0.2, salience: 0.5 },
      });
      assert.equal(r.statusCode, 201, r.body);
    }

    /* pageSize=2 → 第 1 页 2 条，total=3，totalPages=2。
     * 注意：TestClock 固定时钟，3 条 createdAt 相同——正好压测「同一时间戳分页稳定性」：
     * 无 id tie-breaker 时 page1/page2 可能重复/漏项。 */
    const res = await app.inject({
      method: 'GET', url: '/api/v1/companion/me/memories?page=1&pageSize=2', headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['cache-control']), /no-store/);
    const list = CompanionMemoryListV1Schema.parse(JSON.parse(res.body).data);
    assert.equal(list.items.length, 2, '第 1 页应有 2 条');
    assert.equal(list.pagination.total, 3);
    assert.equal(list.pagination.page, 1);
    assert.equal(list.pagination.pageSize, 2);
    assert.equal(list.pagination.totalPages, 2);
    /* 单条形状与 /me 的 recentMemories 同源；且不泄漏企业治理字段 */
    assert.ok(typeof list.items[0].content === 'string' && list.items[0].id.length > 0);
    const leaked = list.items.flatMap((m) => Object.keys(m)).filter(
      (k) => ['confidenceScore', 'sourceKind', 'unverified', 'decayLambda', 'accessCount', 'lastAccessedAt'].includes(k),
    );
    assert.deepEqual(leaked, [], `C 端记忆不应泄漏治理字段: ${leaked.join(',')}`);

    /* 第 2 页 1 条 */
    const res2 = await app.inject({
      method: 'GET', url: '/api/v1/companion/me/memories?page=2&pageSize=2', headers,
    });
    const list2 = CompanionMemoryListV1Schema.parse(JSON.parse(res2.body).data);
    assert.equal(list2.items.length, 1, '第 2 页应有 1 条');

    /* 稳定分页：page1 ∪ page2 = 3 条且 id 互不重复（同时间戳下证明 tie-breaker 生效） */
    const ids = [...list.items, ...list2.items].map((m) => m.id);
    assert.equal(new Set(ids).size, 3, `page1/page2 的 id 应无重复且覆盖全部 3 条，实际 ids=${ids.join(',')}`);
  });

  it('GET /companion/me/memories 空态 → items=[] total=0', async () => {
    const auth = await registerAndGetAuth(app, 'companion-mems-empty@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me/memories', headers });
    assert.equal(res.statusCode, 200, res.body);
    const list = CompanionMemoryListV1Schema.parse(JSON.parse(res.body).data);
    assert.deepEqual(list.items, []);
    assert.equal(list.pagination.total, 0);
  });

  it('GET /companion/me/memories 租户隔离：A 看不到 B 的记忆', async () => {
    const a = await registerAndGetAuth(app, 'companion-tenant-a@test.com');
    const b = await registerAndGetAuth(app, 'companion-tenant-b@test.com');
    const hA = { authorization: `Bearer ${a.accessToken}`, 'x-tenant-id': a.tenantId };
    const hB = { authorization: `Bearer ${b.accessToken}`, 'x-tenant-id': b.tenantId };
    assert.notEqual(a.tenantId, b.tenantId, '两个注册用户应属不同租户');

    await app.inject({ method: 'POST', url: '/api/v1/memories', headers: hA, payload: { kind: 'episodic', content: 'A 的秘密', valence: 0, salience: 0.5 } });
    await app.inject({ method: 'POST', url: '/api/v1/memories', headers: hB, payload: { kind: 'episodic', content: 'B 的秘密', valence: 0, salience: 0.5 } });

    const listA = CompanionMemoryListV1Schema.parse(
      JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/companion/me/memories', headers: hA })).body).data,
    );
    const contentsA = listA.items.map((m) => m.content);
    assert.ok(contentsA.includes('A 的秘密'), 'A 应看到自己的记忆');
    assert.ok(!contentsA.includes('B 的秘密'), 'A 不应看到 B 的记忆（租户隔离）');
  });

  it('plan 门控：enterprise 账号访问 /companion/me/memories → 403', async () => {
    const auth = await registerAndGetAuth(app, 'companion-mems-ent@test.com');
    const entToken = (app as unknown as {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({ sub: auth.userId, tenantId: auth.tenantId, role: 'member', planId: 'enterprise' });
    const headers = { authorization: `Bearer ${entToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me/memories', headers });
    assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
  });

  it('plan 门控：enterprise 账号访问 companion → 403', async () => {
    const auth = await registerAndGetAuth(app, 'companion-ent@test.com');
    /* 用 enterprise plan 自签 token（注册默认无 planId；这里显式模拟企业账号）。
     * 与既有测试一致，用宽松的 sign 类型避免 iat/exp 必填（fastify-jwt 运行时注入）。 */
    const entToken = (app as unknown as {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: auth.userId, tenantId: auth.tenantId, role: 'member', planId: 'enterprise',
    });
    const headers = { authorization: `Bearer ${entToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 403, `expected 403 for enterprise plan, got ${res.statusCode}: ${res.body}`);
  });

  it('plan 门控：API-key 主体（apikey:* sub）访问 companion → 403', async () => {
    const auth = await registerAndGetAuth(app, 'companion-apikey@test.com');
    /* 模拟 API-key 主体：sub 以 apikey: 前缀，planId=free（静态 key 形态） */
    const apiKeyToken = (app as unknown as {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: `apikey:${auth.userId}`, tenantId: auth.tenantId, role: 'service', planId: 'free',
    });
    const headers = { authorization: `Bearer ${apiKeyToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 403, `expected 403 for api-key principal, got ${res.statusCode}: ${res.body}`);
  });

  it('plan 门控：service 角色（非 apikey sub）访问 companion → 403', async () => {
    const auth = await registerAndGetAuth(app, 'companion-service@test.com');
    /* 防御纵深：role=service 但 sub 不带 apikey: 前缀，也应被拒（双重判定） */
    const serviceToken = (app as unknown as {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: auth.userId, tenantId: auth.tenantId, role: 'service', planId: 'free',
    });
    const headers = { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 403, `expected 403 for service role, got ${res.statusCode}: ${res.body}`);
  });

  it('未授权访问 companion → 401/403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me' });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `expected 401/403, got ${res.statusCode}`);
  });

  it('GET /companion/me/nudges + POST .../read —「TA 主动跟我说的」拉取 + 已读（ADR-0054 Phase 2）', async () => {
    const auth = await registerAndGetAuth(app, 'companion-nudge@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* Phase 2 触发逻辑（ProactiveEngine）尚未接入——直接经 store 播种两条主动消息（同租户）。 */
    const store = new ProactiveMessageStore(os.getDatabase(), () => 1000, auth.tenantId);
    store.enqueue({ personaId: 'default', signalType: 'core:memory-consolidated', sourceId: 'm-1', body: '我最近一直在想我们上次聊的', kind: 'memory' });
    store.enqueue({ personaId: 'default', signalType: 'system:evolution-completed', sourceId: 'e-1', body: '我好像又成长了一点', kind: 'growth' });

    /* 拉取未读 nudge。 */
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/companion/me/nudges', headers });
    assert.equal(listRes.statusCode, 200, listRes.body);
    assert.match(String(listRes.headers['cache-control']), /no-store/);
    const items = JSON.parse(listRes.body).data.items as Array<{ id: string; body: string; status: string; kind: string }>;
    assert.equal(items.length, 2, '应拉到两条未读主动消息');
    assert.ok(items.every((i) => i.status === 'unread'));

    /* 标记一条已读 → 未读列表减一。 */
    const target = items[0];
    const readRes = await app.inject({ method: 'POST', url: `/api/v1/companion/me/nudges/${target.id}/read`, headers });
    assert.equal(readRes.statusCode, 200, readRes.body);

    const afterRes = await app.inject({ method: 'GET', url: '/api/v1/companion/me/nudges', headers });
    const afterItems = JSON.parse(afterRes.body).data.items as Array<unknown>;
    assert.equal(afterItems.length, 1, '标记已读后未读列表减一');

    /* 重复标记已读 → 幂等 200（客户端重试友好）。 */
    const reReadRes = await app.inject({ method: 'POST', url: `/api/v1/companion/me/nudges/${target.id}/read`, headers });
    assert.equal(reReadRes.statusCode, 200, '已读再标记应幂等 200');

    /* 标记不存在的 nudge → 404。 */
    const missRes = await app.inject({ method: 'POST', url: '/api/v1/companion/me/nudges/pmsg-nope/read', headers });
    assert.equal(missRes.statusCode, 404);
  });
});
