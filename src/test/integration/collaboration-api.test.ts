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

  /** 创建模拟并返回 simulationId */
  function createSimulation(tenantId: string): string {
    const simId = `sim_test_${Date.now()}`;
    const taskId = `task_test_${Date.now()}`;
    db.prepare(
      `INSERT INTO life_simulations (id, tenant_id, task_id, config_json, status, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'completed', ?, ?)`,
    ).run(simId, tenantId, taskId, Date.now(), Date.now());
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

  afterEach(() => {
    os.close();
  });

  describe('POST /api/v1/simulations/:id/share', () => {
    it('成功分享模拟', async () => {
      const owner = await registerUser('owner@test.com');
      const target = await registerUser('target@test.com');
      const simId = createSimulation(owner.tenantId);

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
      const simId = createSimulation(owner.tenantId);

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
    it('返回被分享的模拟列表', async () => {
      const owner = await registerUser('sharer@test.com');
      const target = await registerUser('receiver@test.com');
      const simId = createSimulation(owner.tenantId);

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
        method: 'GET',
        url: '/api/v1/shared',
        headers: {
          authorization: `Bearer ${target.accessToken}`,
          'x-tenant-id': target.tenantId,
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
  });

  describe('DELETE /api/v1/simulations/:id/share/:userId', () => {
    it('成功删除分享', async () => {
      const owner = await registerUser('del-owner@test.com');
      const target = await registerUser('del-target@test.com');
      const simId = createSimulation(owner.tenantId);

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
