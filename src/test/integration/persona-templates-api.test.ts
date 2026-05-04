/**
 * 集成测试：岗位人格模板 API（P1-A）
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

async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string; userId: string };
}

describe('岗位人格模板 API 集成测试', () => {
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

  it('GET /admin/persona-templates 返回 6 个内置模板', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-list@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/persona-templates',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const items = JSON.parse(res.body).data as Array<{ category: string; isBuiltIn: boolean }>;
    const builtins = items.filter((t) => t.isBuiltIn);
    assert.equal(builtins.length, 6);
  });

  it('POST /admin/persona-templates/:id/instantiate 创建可见 persona', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-inst@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/persona-templates/tpl_builtin_customer_service/instantiate',
      headers,
      payload: { displayName: 'Acme 客服-001' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body).data;
    assert.equal(body.templateId, 'tpl_builtin_customer_service');
    assert.equal(body.instantiatedFromCategory, 'customer_service');

    const personaId = body.persona.id as string;
    assert.ok(personaId.startsWith('pcore_'));

    /* persona 出现在 admin personas 列表中 */
    const personasRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/personas?page=1&pageSize=10',
      headers,
    });
    assert.equal(personasRes.statusCode, 200);
    const personasBody = JSON.parse(personasRes.body);
    const found = (personasBody.data as Array<{ personaId?: string; id?: string }>).some(
      (p) => p.personaId === personaId || p.id === personaId,
    );
    assert.ok(found, `新建 persona ${personaId} 应在 admin personas 列表可见`);
  });

  it('实例化后 persona profile 包含 behaviorBoundaries', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-bound@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/persona-templates/tpl_builtin_legal/instantiate',
      headers,
      payload: { displayName: '法务 Bot' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body).data;
    const profile = body.persona.profile as Record<string, unknown>;
    assert.equal(profile.templateCategory, 'legal');
    assert.ok(Array.isArray(profile.behaviorBoundaries));
    const boundaries = profile.behaviorBoundaries as Array<{ rule: string; topic: string }>;
    assert.ok(boundaries.length > 0);
    assert.ok(boundaries.some((b) => b.rule === 'always_escalate'));
  });

  it('PATCH 内置模板返回 403', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-patch-builtin@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/persona-templates/tpl_builtin_engineer',
      headers,
      payload: { label: '篡改' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('GET /:id/variables 列出占位符列表', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-vars@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/persona-templates/tpl_builtin_customer_service/variables',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body).data;
    assert.equal(body.templateId, 'tpl_builtin_customer_service');
    assert.deepEqual(body.variables, ['escalation_role', 'refund_threshold']);
  });

  it('instantiate templateVariables 端到端渲染', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-render@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/persona-templates/tpl_builtin_finance/instantiate',
      headers,
      payload: {
        displayName: 'Acme 财务-PROD',
        templateVariables: { budget_overrun_threshold: '8%' },
      },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body).data;
    const profile = body.persona.profile as Record<string, unknown>;
    const boundaries = profile.behaviorBoundaries as Array<{ rule: string; topic: string }>;
    const budgetRule = boundaries.find((b) => b.rule === 'always_escalate');
    assert.ok(budgetRule);
    assert.ok(budgetRule.topic.includes('8%'), `topic should include '8%': ${budgetRule.topic}`);
    assert.ok(!budgetRule.topic.includes('{{'), '占位符应已替换');
  });

  it('POST 创建 + DELETE 自定义模板 roundtrip', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'tpl-crud@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/persona-templates',
      headers,
      payload: {
        category: 'sales',
        label: 'Acme 销售',
        description: '内部销售岗位定制模板',
      },
    });
    assert.equal(createRes.statusCode, 201);
    const created = JSON.parse(createRes.body).data;
    assert.equal(created.isBuiltIn, false);
    assert.ok(created.id.startsWith('tpl_'));

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/persona-templates/${created.id}`,
      headers,
    });
    assert.equal(deleteRes.statusCode, 204);

    /* 删除后再查应 404 */
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/persona-templates/${created.id}`,
      headers,
    });
    assert.equal(getRes.statusCode, 404);
  });
});
