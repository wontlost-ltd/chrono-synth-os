/**
 * 集成测试：知识批量导入 API（P1-B）
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

async function createPersona(
  app: FastifyInstance,
  headers: Record<string, string>,
  displayName: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/persona-core',
    headers,
    payload: { displayName },
  });
  assert.equal(res.statusCode, 201);
  return (JSON.parse(res.body).data as { id: string }).id;
}

describe('知识批量导入 API 集成测试', () => {
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

  it('POST 5 个 text source → state=completed, importedCount=5', async () => {
    const auth = await registerAndGetAuth(app, 'bki-sync@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const personaId = await createPersona(app, headers, 'Sync Persona');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports`,
      headers,
      payload: {
        sources: Array.from({ length: 5 }, (_, i) => ({
          kind: 'text',
          content: `body ${i}`,
          title: `doc ${i}`,
        })),
        deduplicateStrategy: 'skip',
      },
    });
    assert.equal(res.statusCode, 200);  // sync 路径返回 200
    const body = JSON.parse(res.body).data;
    assert.equal(body.mode, 'sync');
    assert.equal(body.totalItems, 5);
    assert.equal(body.state, 'completed');
    assert.equal(body.job.importedCount, 5);
  });

  it('GET /:jobId 查询 job 状态', async () => {
    const auth = await registerAndGetAuth(app, 'bki-status@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const personaId = await createPersona(app, headers, 'Status Persona');

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports`,
      headers,
      payload: {
        sources: [{ kind: 'text', content: 'hello', title: 'h' }],
        deduplicateStrategy: 'skip',
      },
    });
    const jobId = (JSON.parse(submitRes.body).data as { jobId: string }).jobId;

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports/${jobId}`,
      headers,
    });
    assert.equal(getRes.statusCode, 200);
    const job = JSON.parse(getRes.body).data;
    assert.equal(job.id, jobId);
    assert.equal(job.state, 'completed');
    assert.equal(job.importedCount, 1);
  });

  it('非 owner 调用返回 404（持有不匹配 personaId）', async () => {
    const ownerAuth = await registerAndGetAuth(app, 'bki-owner@test.com');
    const ownerHeaders = { authorization: `Bearer ${ownerAuth.accessToken}`, 'x-tenant-id': ownerAuth.tenantId };
    const personaId = await createPersona(app, ownerHeaders, 'Owned Persona');

    const otherAuth = await registerAndGetAuth(app, 'bki-other@test.com');
    const otherHeaders = { authorization: `Bearer ${otherAuth.accessToken}`, 'x-tenant-id': otherAuth.tenantId };

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports`,
      headers: otherHeaders,
      payload: {
        sources: [{ kind: 'text', content: 'x', title: 'x' }],
        deduplicateStrategy: 'skip',
      },
    });
    assert.equal(res.statusCode, 404);
  });

  it('部分失败：URL 拒绝 SSRF 计入 failedCount，text 仍写入', async () => {
    const auth = await registerAndGetAuth(app, 'bki-mixed@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const personaId = await createPersona(app, headers, 'Mixed Persona');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports`,
      headers,
      payload: {
        sources: [
          { kind: 'text', content: 'success body', title: 'good' },
          { kind: 'url', content: 'http://10.0.0.1/internal', title: 'ssrf' },
        ],
        deduplicateStrategy: 'skip',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body).data;
    assert.equal(body.job.importedCount, 1);
    assert.equal(body.job.failedCount, 1);
    assert.equal(body.job.failures.length, 1);
    assert.equal(body.job.failures[0].index, 1);
  });

  it('GET /bulk-knowledge-imports 列出最近 job', async () => {
    const auth = await registerAndGetAuth(app, 'bki-list@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const personaId = await createPersona(app, headers, 'List Persona');

    /* 创建 3 个 job */
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports`,
        headers,
        payload: {
          sources: [{ kind: 'text', content: `body ${i}`, title: `t-${i}` }],
          deduplicateStrategy: 'skip',
        },
      });
    }

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/persona-core/${personaId}/bulk-knowledge-imports`,
      headers,
    });
    assert.equal(listRes.statusCode, 200);
    const jobs = JSON.parse(listRes.body).data as Array<{ totalItems: number; state: string }>;
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((j) => j.state === 'completed'));
  });
});
