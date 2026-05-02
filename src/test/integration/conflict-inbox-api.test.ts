/**
 * 冲突收件箱 API 集成测试
 *
 * 覆盖 list / get / create (service role) / resolve 完整 round-trip，
 * 以及 web 客户端依赖的 @chrono/contracts 模式解析（跨栈契约验证）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import {
  ConflictInboxItemV1Schema,
  ConflictResolveResultV1Schema,
} from '@chrono/contracts';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

const CONFLICT_ITEM = {
  schemaVersion: 'conflict-inbox.v1',
  conflictId: 'conflict_test_001',
  conflictVersion: 'v1',
  entityType: 'persona',
  entityId: 'persona_abc',
  sourceRuntime: 'web',
  detectedAt: new Date().toISOString(),
  severity: 'warning',
  localSummaryId: 'conflict.local.newer' as const,
  localSummaryParams: {},
  serverSummaryId: 'conflict.server.different' as const,
  serverSummaryParams: {},
  suggestedActions: ['keep_local', 'keep_server'],
} as const;

describe('冲突收件箱 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let db: IDatabase;

  let userToken: string;
  let tenantId: string;
  let serviceToken: string;

  const config = loadConfig({
    rateLimit: { max: 10_000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  async function registerUser(email: string): Promise<{ accessToken: string; tenantId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    assert.ok(res.statusCode === 200 || res.statusCode === 201, `register failed: ${res.statusCode} ${res.body}`);
    return (JSON.parse(res.body) as { data: { accessToken: string; tenantId: string } }).data;
  }


  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    db = os.getDatabase();
    app = await createApp({ os, config, db });

    // First registration becomes admin; second becomes a regular member
    const admin = await registerUser(`admin_${Date.now()}@test.local`);
    serviceToken = admin.accessToken;

    const user = await registerUser(`user_${Date.now()}@test.local`);
    userToken = user.accessToken;
    tenantId = user.tenantId;
  });

  afterEach(() => {
    os.close();
  });

  // ── GET /api/v1/conflicts ──────────────────────────────────────────────────

  describe('GET /api/v1/conflicts', () => {
    it('returns empty list when no conflicts exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { data: unknown[] };
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data.length, 0);
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/conflicts' });
      assert.equal(res.statusCode, 401);
    });

    it('lists conflicts after creation, only for current tenant', async () => {
      // Create conflict under current tenant via service role
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': tenantId },
        payload: { ...CONFLICT_ITEM, tenantId },
      });

      // Create conflict under different tenant — should not appear
      const other = await registerUser(`other_${Date.now()}@test.local`);
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': other.tenantId },
        payload: { ...CONFLICT_ITEM, conflictId: 'conflict_other_001', tenantId: other.tenantId },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { data: unknown[] };
      assert.equal(body.data.length, 1);
    });
  });

  // ── POST /api/v1/conflicts (service role) ─────────────────────────────────

  describe('POST /api/v1/conflicts (service/admin only)', () => {
    it('creates conflict and response parses through @chrono/contracts schema', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': tenantId },
        payload: { ...CONFLICT_ITEM, tenantId },
      });
      assert.equal(res.statusCode, 200);

      // Cross-stack contract: response must parse through the same schema web uses
      const body = JSON.parse(res.body) as { data: unknown };
      const parsed = ConflictInboxItemV1Schema.safeParse(body.data);
      assert.ok(parsed.success, `@chrono/contracts parse failed: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.data.conflictId, CONFLICT_ITEM.conflictId);
      assert.equal(parsed.data.entityType, CONFLICT_ITEM.entityType);
      assert.equal(parsed.data.severity, CONFLICT_ITEM.severity);
    });

    it('returns 401 for unauthenticated conflict creation', async () => {
      // Every new registration creates a fresh tenant and gets admin role — there is no
      // way to produce a member-role user via the register endpoint. Testing that the
      // route requires authentication is the meaningful guard here.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        payload: { ...CONFLICT_ITEM, tenantId },
      });
      assert.equal(res.statusCode, 401);
    });

    it('returns 400 for malformed payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': tenantId },
        payload: { invalid: true },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  // ── GET /api/v1/conflicts/:conflictId ─────────────────────────────────────

  describe('GET /api/v1/conflicts/:conflictId', () => {
    it('returns single conflict by id', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': tenantId },
        payload: { ...CONFLICT_ITEM, tenantId },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conflicts/${CONFLICT_ITEM.conflictId}`,
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { data: unknown };
      const parsed = ConflictInboxItemV1Schema.safeParse(body.data);
      assert.ok(parsed.success);
      assert.equal(parsed.data.conflictId, CONFLICT_ITEM.conflictId);
    });

    it('returns 404 for unknown conflict', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/conflicts/conflict_nonexistent',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
      });
      assert.equal(res.statusCode, 404);
    });

    it('returns 404 when conflict belongs to different tenant', async () => {
      const other = await registerUser(`other2_${Date.now()}@test.local`);
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': other.tenantId },
        payload: { ...CONFLICT_ITEM, conflictId: 'conflict_cross_tenant', tenantId: other.tenantId },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/conflicts/conflict_cross_tenant',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  // ── POST /api/v1/conflicts/:conflictId/resolve ────────────────────────────

  describe('POST /api/v1/conflicts/:conflictId/resolve', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': tenantId },
        payload: { ...CONFLICT_ITEM, tenantId },
      });
    });

    it('resolves conflict and response parses through @chrono/contracts schema', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conflicts/${CONFLICT_ITEM.conflictId}/resolve`,
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
        payload: {
          conflictId: CONFLICT_ITEM.conflictId,
          ifMatch: CONFLICT_ITEM.conflictVersion,
          action: 'keep_local',
        },
      });
      assert.equal(res.statusCode, 200);

      // Cross-stack contract: result must parse through the same schema web uses
      const body = JSON.parse(res.body) as { data: unknown };
      const parsed = ConflictResolveResultV1Schema.safeParse(body.data);
      assert.ok(parsed.success, `@chrono/contracts parse failed: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.data.conflictId, CONFLICT_ITEM.conflictId);
      assert.equal(parsed.data.action, 'keep_local');
      assert.ok(parsed.data.resolvedAt);
    });

    it('resolved conflict no longer appears in list', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/conflicts/${CONFLICT_ITEM.conflictId}/resolve`,
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
        payload: {
          conflictId: CONFLICT_ITEM.conflictId,
          ifMatch: CONFLICT_ITEM.conflictVersion,
          action: 'keep_server',
        },
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
      });
      assert.equal(listRes.statusCode, 200);
      const body = JSON.parse(listRes.body) as { data: unknown[] };
      assert.equal(body.data.length, 0);
    });

    it('returns 409 on version mismatch (optimistic lock)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conflicts/${CONFLICT_ITEM.conflictId}/resolve`,
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
        payload: {
          conflictId: CONFLICT_ITEM.conflictId,
          ifMatch: 'stale-version',
          action: 'keep_local',
        },
      });
      assert.equal(res.statusCode, 409);
    });

    it('returns 400 on conflictId mismatch between URL and body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conflicts/${CONFLICT_ITEM.conflictId}/resolve`,
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
        payload: {
          conflictId: 'wrong_id',
          ifMatch: CONFLICT_ITEM.conflictVersion,
          action: 'keep_local',
        },
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 404 on resolve attempt for another tenant conflict', async () => {
      const other = await registerUser(`other3_${Date.now()}@test.local`);
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': other.tenantId },
        payload: { ...CONFLICT_ITEM, conflictId: 'conflict_cross_resolve', tenantId: other.tenantId },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts/conflict_cross_resolve/resolve',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
        payload: {
          conflictId: 'conflict_cross_resolve',
          ifMatch: CONFLICT_ITEM.conflictVersion,
          action: 'keep_local',
        },
      });
      assert.equal(res.statusCode, 404);
    });

    it('remainingBlockingCount is 0 after resolving the only blocking conflict', async () => {
      // Create a blocking-severity conflict
      const blockingItem = {
        ...CONFLICT_ITEM,
        conflictId: 'conflict_blocking_001',
        severity: 'blocking',
        tenantId,
      };
      await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts',
        headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': tenantId },
        payload: blockingItem,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conflicts/conflict_blocking_001/resolve',
        headers: { authorization: `Bearer ${userToken}`, 'x-tenant-id': tenantId },
        payload: {
          conflictId: 'conflict_blocking_001',
          ifMatch: CONFLICT_ITEM.conflictVersion,
          action: 'duplicate',
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { data: { remainingBlockingCount: number; resultingSyncState: string } };
      assert.equal(body.data.remainingBlockingCount, 0);
      assert.equal(body.data.resultingSyncState, 'online_synced');
    });
  });
});
