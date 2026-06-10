/**
 * GET /api/v1/snapshots/:id 安全契约（ADR-0046 路线 A PR-3，Codex 审查 Major）。
 *
 * 该端点导出**完整系统快照**（data_json 可能含凭据/工具权限），敏感度高于列表元数据。锁住：
 *   - 未认证 → 401；
 *   - 非 admin（member）→ 403（requireRole('admin')）；
 *   - admin 可读自己租户的快照（200 + data_json）；
 *   - 跨租户：admin A 读不到 admin B 的快照 id（404，租户经 JWT 隔离，非 header）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

function signToken(app: FastifyInstance, payload: Record<string, unknown>): string {
  return (app as unknown as { jwt: { sign: (p: Record<string, unknown>) => string } }).jwt.sign(payload);
}

async function registerAndGetAuth(
  app: FastifyInstance,
  email: string,
): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string; userId: string };
}

/** 用 admin 角色自签 token（注册默认 member）。 */
function adminHeaders(app: FastifyInstance, userId: string, tenantId: string) {
  const token = signToken(app, { sub: userId, tenantId, role: 'admin' });
  return { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
}

/** member 角色 headers（自签；注册默认是 admin/owner，故 member 需显式签）。 */
function memberHeaders(app: FastifyInstance, userId: string, tenantId: string) {
  const token = signToken(app, { sub: userId, tenantId, role: 'member' });
  return { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
}

/** 创建一个快照（用 admin），返回其 id。reason 必须是合法枚举。 */
async function createSnapshot(app: FastifyInstance, headers: Record<string, string>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/snapshots', headers, payload: { reason: 'manual' } });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).data.id as string;
}

describe('GET /api/v1/snapshots/:id 安全契约', () => {
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

  it('未认证 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/snapshots/snap_x' });
    assert.equal(res.statusCode, 401, res.body);
  });

  it('非 admin（member）→ 403', async () => {
    /* 注册首用户是 admin/owner，故显式自签一个 member token 来验证角色门。 */
    const auth = await registerAndGetAuth(app, 'snap-member@test.com');
    const headers = memberHeaders(app, auth.userId, auth.tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/v1/snapshots/snap_x', headers });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('admin 可读自己租户快照（200 + data_json）', async () => {
    const auth = await registerAndGetAuth(app, 'snap-admin@test.com');
    const headers = adminHeaders(app, auth.userId, auth.tenantId);
    const id = await createSnapshot(app, headers);

    const res = await app.inject({ method: 'GET', url: `/api/v1/snapshots/${id}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data;
    assert.equal(data.id, id);
    assert.equal(typeof data.dataJson, 'string');
  });

  it('跨租户：admin A 读不到 admin B 的快照 id → 404（tenant 经 JWT 隔离）', async () => {
    const authA = await registerAndGetAuth(app, 'snap-tenantA@test.com');
    const authB = await registerAndGetAuth(app, 'snap-tenantB@test.com');
    assert.notEqual(authA.tenantId, authB.tenantId, '两个注册应得到不同租户');

    const headersB = adminHeaders(app, authB.userId, authB.tenantId);
    const idB = await createSnapshot(app, headersB);

    /* A 用自己的 admin token 请求 B 的快照 id：getOS 按 A 的 tenant 取，A 的库里没有 idB → 404。 */
    const headersA = adminHeaders(app, authA.userId, authA.tenantId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/snapshots/${idB}`, headers: headersA });
    assert.equal(res.statusCode, 404, `A 不应读到 B 的快照，got ${res.statusCode}: ${res.body}`);
  });
});
