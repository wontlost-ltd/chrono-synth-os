/**
 * AI 安全治理集成测试
 * 覆盖：memory confidence、persona drift 监测、safety status 聚合端点
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

async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string };
}

describe('AI 安全治理集成测试', () => {
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

  it('POST /memories 默认 sourceKind → GET /memories 返回 confidenceScore 和 unverified', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'memory-conf-default@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { kind: 'semantic', content: 'default source test', valence: 0.5, salience: 0.5 },
      headers,
    });
    assert.equal(createRes.statusCode, 201);
    const createdId = (JSON.parse(createRes.body).data as { id: string }).id;

    const listRes = await app.inject({ method: 'GET', url: '/api/v1/memories', headers });
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    assert.ok(body.data.length > 0, 'should have at least one memory');
    const mem = (body.data as Array<{ id: string; confidenceScore: number; unverified: boolean; sourceKind: string }>)
      .find((m) => m.id === createdId);
    assert.ok(mem, `memory ${createdId} not found in list`);
    assert.ok(typeof mem.confidenceScore === 'number', 'confidenceScore must be a number');
    assert.ok(typeof mem.unverified === 'boolean', 'unverified must be a boolean');
    assert.ok(typeof mem.sourceKind === 'string', 'sourceKind must be a string');
    // 默认 sourceKind=user_input → confidenceScore=0.95, unverified=false
    assert.equal(mem.confidenceScore, 0.95);
    assert.equal(mem.unverified, false);
    assert.equal(mem.sourceKind, 'user_input');
  });

  it('POST /memories 携带 sourceKind=api_sync → confidenceScore=0.70, unverified=true', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'memory-conf-api-sync@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { kind: 'semantic', content: 'api sync memory', valence: 0.5, salience: 0.5, sourceKind: 'api_sync' },
      headers,
    });
    assert.equal(createRes.statusCode, 201);
    const createdId = (JSON.parse(createRes.body).data as { id: string }).id;

    const listRes = await app.inject({ method: 'GET', url: '/api/v1/memories', headers });
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const mem = (body.data as Array<{ id: string; confidenceScore: number; unverified: boolean; sourceKind: string }>)
      .find((m) => m.id === createdId);
    assert.ok(mem, `memory ${createdId} not found in list`);
    assert.equal(mem.sourceKind, 'api_sync');
    assert.equal(mem.confidenceScore, 0.70);
    assert.equal(mem.unverified, true);
  });

  it('POST /operations/evolution/run 成功后 GET /admin/safety/drift-report 返回报告', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'drift-report@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    // 先跑一次演化（会产生前/后两个快照，满足漂移分析所需的 2 个快照）
    const evoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/evolution/run',
      headers,
    });
    assert.equal(evoRes.statusCode, 200);
    const evoBody = JSON.parse(evoRes.body);
    assert.ok(evoBody.data);

    // 此时 POST drift-report 应能生成并返回报告（至少 2 个快照）
    const postReportRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/safety/drift-report',
      headers,
    });
    assert.equal(postReportRes.statusCode, 200);
    const reportBody = JSON.parse(postReportRes.body).data;
    assert.ok(reportBody.reportId, 'reportId must be present');
    assert.ok(typeof reportBody.overallDriftScore === 'number', 'overallDriftScore must be a number');
    assert.ok(['ok', 'warning', 'critical'].includes(reportBody.alertLevel), 'alertLevel must be valid');
    assert.ok(Array.isArray(reportBody.valueDrifts), 'valueDrifts must be an array');

    // GET drift-report 应返回最新报告（结构正确）
    const getReportRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/safety/drift-report',
      headers,
    });
    assert.equal(getReportRes.statusCode, 200);
    const getReportBody = JSON.parse(getReportRes.body).data;
    assert.ok(getReportBody.reportId, 'GET drift-report should return a reportId');
    assert.ok(['ok', 'warning', 'critical'].includes(getReportBody.alertLevel));
  });

  it('GET /admin/safety/status 返回正确结构', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'safety-status@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    // 先创建一条内存（有置信度数据）
    const memRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { kind: 'semantic', content: 'status test', valence: 0.5, salience: 0.5 },
      headers,
    });
    assert.equal(memRes.statusCode, 201);

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/safety/status',
      headers,
    });
    assert.equal(statusRes.statusCode, 200);
    const body = JSON.parse(statusRes.body).data;

    // memoryConfidence 结构校验
    assert.ok(typeof body.memoryConfidence === 'object', 'memoryConfidence must be present');
    assert.ok(typeof body.memoryConfidence.totalCount === 'number');
    assert.ok(typeof body.memoryConfidence.unverifiedCount === 'number');
    assert.ok(typeof body.memoryConfidence.unverifiedRatio === 'number');
    assert.ok(typeof body.memoryConfidence.bySourceKind === 'object');

    // personaDrift 结构校验
    assert.ok(typeof body.personaDrift === 'object', 'personaDrift must be present');
    assert.ok(Array.isArray(body.personaDrift.recentAlerts));

    // safetyScore 范围校验
    assert.ok(typeof body.safetyScore === 'number');
    assert.ok(body.safetyScore >= 0 && body.safetyScore <= 100, `safetyScore out of range: ${body.safetyScore}`);

    // 应有至少 1 条记忆（刚创建的）
    assert.ok(body.memoryConfidence.totalCount >= 1);
    // bySourceKind 至少有一个非空 source_kind 类别
    const kindCount = Object.values(body.memoryConfidence.bySourceKind as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.ok(kindCount >= 1, 'bySourceKind should have at least 1 total count');
  });

  it('GET /admin/safety/status 按 tenantId 隔离，不串到其他租户', async () => {
    const tenantA = await registerAndGetAuth(app, 'safety-tenant-a@test.com');
    const tenantB = await registerAndGetAuth(app, 'safety-tenant-b@test.com');
    const headersA = { authorization: `Bearer ${tenantA.accessToken}`, 'x-tenant-id': tenantA.tenantId };
    const headersB = { authorization: `Bearer ${tenantB.accessToken}`, 'x-tenant-id': tenantB.tenantId };

    // 租户 A 创建 2 条记忆，租户 B 创建 1 条
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        payload: { kind: 'semantic', content: `A memory ${i}`, valence: 0.5, salience: 0.5 },
        headers: headersA,
      });
    }
    await app.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { kind: 'semantic', content: 'B memory', valence: 0.5, salience: 0.5 },
      headers: headersB,
    });

    const statusARes = await app.inject({ method: 'GET', url: '/api/v1/admin/safety/status', headers: headersA });
    const statusBRes = await app.inject({ method: 'GET', url: '/api/v1/admin/safety/status', headers: headersB });
    const bodyA = JSON.parse(statusARes.body).data;
    const bodyB = JSON.parse(statusBRes.body).data;

    assert.equal(bodyA.memoryConfidence.totalCount, 2, '租户 A 应只看到自己的 2 条记忆');
    assert.equal(bodyB.memoryConfidence.totalCount, 1, '租户 B 应只看到自己的 1 条记忆');
  });

  it('PATCH /admin/config 调整 safety.drift 阈值后立即生效', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'drift-threshold@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    // 调整阈值（warning=0.05 / critical=0.10，比默认值低很多）
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/config',
      headers,
      payload: {
        'safety.drift.warningThreshold': 0.05,
        'safety.drift.criticalThreshold': 0.10,
      },
    });
    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.body).data;
    assert.equal(patchBody.updated, 2);

    // GET /admin/config 应返回新阈值
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers });
    assert.equal(getRes.statusCode, 200);
    const items = (JSON.parse(getRes.body).data.items as Array<{ key: string; value: unknown }>);
    const warningItem = items.find((i) => i.key === 'safety.drift.warningThreshold');
    const criticalItem = items.find((i) => i.key === 'safety.drift.criticalThreshold');
    assert.ok(warningItem, 'safety.drift.warningThreshold should be in config items');
    assert.ok(criticalItem, 'safety.drift.criticalThreshold should be in config items');
    assert.equal(warningItem.value, 0.05);
    assert.equal(criticalItem.value, 0.10);
  });

  it('演化后 audit_log 中有 persona.drift 记录（当 alertLevel != ok）', async () => {
    const { accessToken, tenantId } = await registerAndGetAuth(app, 'drift-audit@test.com');
    const headers = { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId };

    // 跑演化（产生快照 + 触发漂移分析）
    const evoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/evolution/run',
      headers,
    });
    assert.equal(evoRes.statusCode, 200);

    // 读取 audit_log，若 alertLevel != ok 则应有 persona.drift.* 记录
    const db = os.getDatabase();
    const driftAlerts = db.prepare<{ action_type: string }>(
      `SELECT action_type FROM audit_log
        WHERE event_kind = 'business'
          AND action_type LIKE 'persona.drift.%'
        ORDER BY created_at DESC LIMIT 10`,
    ).all();

    // 查最近漂移报告，判断是否预期有 audit 记录
    const latestReport = db.prepare<{ alert_level: string }>(
      'SELECT alert_level FROM drift_analysis_log ORDER BY analyzed_at DESC LIMIT 1',
    ).get();

    if (latestReport && latestReport.alert_level !== 'ok') {
      assert.ok(driftAlerts.length > 0, 'should have persona.drift audit record when alertLevel != ok');
      assert.ok(driftAlerts[0].action_type.startsWith('persona.drift.'));
    }
    // 若 alertLevel = 'ok' 时不写 audit_log（合理），直接通过
  });
});
