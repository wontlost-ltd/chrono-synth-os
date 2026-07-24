/**
 * 协作 API 集成测试
 * 覆盖 share / list-shared / unshare
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

describe('协作 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let db: IDatabase;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  /** 注册用户并返回 accessToken + tenantId + userId */
  async function registerUser(email: string): Promise<{ accessToken: string; tenantId: string; userId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    return JSON.parse(res.body).data;
  }

  /**
   * 为「同租户成员」铸 access token。
   *
   * 分片 Phase 0 · Plan 1b（Task 4）：sharding 后分享是**租户内**语义——
   * listSharedWithUser 经 life_simulations 父归属 `WHERE ls.tenant_id=?` 隔离，
   * request.tenantId 强制取自 JWT（tenant.ts 插件，不可被 header 覆盖）。故被分享者要看到分享，
   * 其 JWT 必须与被分享模拟同租户。registerUser 每次铸新租户，这里直接用 app.jwtSign 为
   * 同一 tenantId 的用户铸 token（模拟 owner 租户内的另一成员），而非跨租户注册。
   */
  function tokenForTenantMember(userId: string, tenantId: string): string {
    const appWithJwt = app as unknown as { jwtSign?: (p: unknown) => string; jwt: { sign: (p: unknown) => string } };
    const payload = { sub: userId, tenantId, role: 'member', planId: 'free', jti: `jti_${userId}` };
    return appWithJwt.jwtSign ? appWithJwt.jwtSign(payload) : appWithJwt.jwt.sign(payload);
  }

  /** 创建模拟并返回 simulationId。ownerUserId=模拟创建者（owner-only 分享鉴权基础）。 */
  function createSimulation(tenantId: string, ownerUserId: string | null = null): string {
    const simId = `sim_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskId = `task_test_${Date.now()}`;
    db.prepare(
      `INSERT INTO life_simulations (id, tenant_id, task_id, config_json, status, owner_user_id, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'completed', ?, ?, ?)`,
    ).run(simId, tenantId, taskId, ownerUserId, Date.now(), Date.now());
    return simId;
  }

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    db = os.getDatabase();
    app = await createApp({ os, config, db });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  describe('POST /api/v1/simulations/:id/share', () => {
    it('成功分享模拟', async () => {
      const owner = await registerUser('owner@test.com');
      const target = await registerUser('target@test.com');
      const simId = createSimulation(owner.tenantId, owner.userId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
        payload: { userId: target.userId, permission: 'view' },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id);
      assert.equal(body.data.simulationId, simId);
      assert.equal(body.data.userId, target.userId);
      assert.equal(body.data.permission, 'view');
      assert.equal(body.data.created, true);
    });

    it('重复分享更新权限', async () => {
      const owner = await registerUser('owner2@test.com');
      const target = await registerUser('target2@test.com');
      const simId = createSimulation(owner.tenantId, owner.userId);

      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
        payload: { userId: target.userId, permission: 'view' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
        payload: { userId: target.userId, permission: 'edit' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.permission, 'edit');
      assert.equal(body.data.created, false);
    });

    it('未认证返回 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/simulations/sim_xxx/share',
        payload: { userId: 'user_xxx', permission: 'view' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('★owner-only 抢注防护★：非 owner 分享别人的模拟 → 403（不能把自己变 owner）', async () => {
      const attacker = await registerUser('attacker@test.com');
      const victim = await registerUser('victim@test.com');
      /* 模拟的真实 owner = victim（同租户，但非 attacker）。 */
      const simId = createSimulation(attacker.tenantId, victim.userId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: { authorization: `Bearer ${attacker.accessToken}`, 'x-tenant-id': attacker.tenantId },
        payload: { userId: 'someone', permission: 'view' },
      });
      /* attacker 非模拟创建者 → owner-only 拒绝（403），杜绝抢注把自己写成 owner。 */
      assert.equal(res.statusCode, 403);
    });

    it('★owner=null 历史模拟保守拒绝★：无主模拟（owner_user_id=null）任何人分享 → 403（fail-closed）', async () => {
      const user = await registerUser('legacy-sharer@test.com');
      /* owner_user_id=null 模拟历史遗留无主。 */
      const simId = createSimulation(user.tenantId, null);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-tenant-id': user.tenantId },
        payload: { userId: 'someone', permission: 'view' },
      });
      assert.equal(res.statusCode, 403);
    });

    it('不存在的模拟返回 404', async () => {
      const owner = await registerUser('owner3@test.com');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/simulations/nonexistent/share',
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
        payload: { userId: 'user_xxx', permission: 'view' },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /api/v1/shared', () => {
    it('返回被分享的模拟列表（同租户成员视角）', async () => {
      const owner = await registerUser('sharer@test.com');
      /* 被分享者是 owner 租户内的另一成员——sharding 后分享是租户内语义。 */
      const targetUserId = 'member_receiver';
      const targetToken = tokenForTenantMember(targetUserId, owner.tenantId);
      const simId = createSimulation(owner.tenantId, owner.userId);

      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
        payload: { userId: targetUserId, permission: 'view' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shared',
        headers: {
          authorization: `Bearer ${targetToken}`,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].simulationId, simId);
      assert.ok(body.pagination);
      assert.equal(body.pagination.total, 1);
    });

    it('租户隔离：他租户成员看不到本租户内的分享', async () => {
      const owner = await registerUser('sharer-iso@test.com');
      const targetUserId = 'member_receiver_iso';
      const simId = createSimulation(owner.tenantId, owner.userId);
      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-tenant-id': owner.tenantId },
        payload: { userId: targetUserId, permission: 'view' },
      });
      /* 同名 userId 但属另一租户（JWT tenantId 不同）→ 父归属 predicate 隔离 → 空。 */
      const otherTenantToken = tokenForTenantMember(targetUserId, 'tenant_other_iso');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shared',
        headers: { authorization: `Bearer ${otherTenantToken}` },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 0, '他租户成员查不到本租户内的分享（父归属 predicate 隔离）');
      assert.equal(body.pagination.total, 0);
    });
  });

  describe('GET /api/v1/simulations/:id/shares（列某模拟分享给了谁，owner 视角）', () => {
    it('owner 能列出该模拟分享给了谁', async () => {
      const owner = await registerUser('list-owner@test.com');
      const target = await registerUser('list-target@test.com');
      const simId = createSimulation(owner.tenantId, owner.userId);

      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-tenant-id': owner.tenantId },
        payload: { userId: target.userId, permission: 'edit' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/simulations/${simId}/shares`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-tenant-id': owner.tenantId },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].targetUserId, target.userId);
      assert.equal(body.data[0].permission, 'edit');
      assert.ok(body.data[0].id);
    });

    it('★鉴权★：他人（不同租户）列该模拟的分享 → 404（跨租户不泄露模拟存在性）', async () => {
      const owner = await registerUser('list-owner2@test.com');
      const target = await registerUser('list-target2@test.com');
      const stranger = await registerUser('list-stranger@test.com');
      const simId = createSimulation(owner.tenantId, owner.userId);

      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-tenant-id': owner.tenantId },
        payload: { userId: target.userId, permission: 'view' },
      });

      /* stranger 用自己的租户上下文列 owner 的模拟 → 模拟在其租户不存在 → 404（先于 owner 校验拦截，
       * 不泄露「该模拟存在且分享给了谁」）。跨租户隔离的第一道防线。 */
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/simulations/${simId}/shares`,
        headers: { authorization: `Bearer ${stranger.accessToken}`, 'x-tenant-id': stranger.tenantId },
      });
      assert.equal(res.statusCode, 404);
    });

    it('无分享的模拟 → 空列表', async () => {
      const owner = await registerUser('list-empty@test.com');
      const simId = createSimulation(owner.tenantId, owner.userId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/simulations/${simId}/shares`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-tenant-id': owner.tenantId },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body).data, []);
    });
  });

  describe('DELETE /api/v1/simulations/:id/share/:userId', () => {
    it('成功删除分享', async () => {
      const owner = await registerUser('del-owner@test.com');
      const target = await registerUser('del-target@test.com');
      const simId = createSimulation(owner.tenantId, owner.userId);

      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simId}/share`,
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
        payload: { userId: target.userId, permission: 'view' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/simulations/${simId}/share/${target.userId}`,
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          'x-tenant-id': owner.tenantId,
        },
      });
      assert.equal(res.statusCode, 204);

      /* 确认已删除 */
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/shared',
        headers: {
          authorization: `Bearer ${target.accessToken}`,
          'x-tenant-id': target.tenantId,
        },
      });
      const body = JSON.parse(listRes.body);
      assert.equal(body.data.length, 0);
    });
  });
});
