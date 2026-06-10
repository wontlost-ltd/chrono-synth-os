import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp, serverState } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { IdentityService } from '../../identity/identity-service.js';
import type { FastifyInstance } from 'fastify';

describe('API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  describe('健康检查', () => {
    it('GET /healthz 返回 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.version, '2.0.0');
      assert.equal(typeof body.uptime, 'number');
    });

    it('GET /readyz 返回 200 包含 components', async () => {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      const body = JSON.parse(res.body);
      assert.ok(body.components);
      assert.ok(body.components.os);
      assert.ok(body.components.database);
    });
  });

  describe('请求 ID 和追踪', () => {
    it('响应包含 X-Request-Id 和 X-Correlation-Id', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.ok(res.headers['x-request-id']);
      assert.ok(res.headers['x-correlation-id']);
    });

    it('透传客户端提供的 X-Request-Id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'custom-id-123' },
      });
      assert.equal(res.headers['x-request-id'], 'custom-id-123');
    });

    it('响应包含 X-Trace-Id', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.ok(res.headers['x-trace-id']);
    });

    it('透传客户端提供的 X-Trace-Id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-trace-id': 'trace-abc-123' },
      });
      assert.equal(res.headers['x-trace-id'], 'trace-abc-123');
    });
  });

  describe('安全头', () => {
    it('响应包含 Helmet 安全头', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.ok(res.headers['x-dns-prefetch-control']);
      assert.ok(res.headers['x-content-type-options']);
    });
  });

  describe('价值管理', () => {
    it('POST /api/v1/values 创建价值', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/values',
        payload: { label: '诚实', weight: 0.8 },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.data.label, '诚实');
      assert.equal(body.data.weight, 0.8);
    });

    it('GET /api/v1/values 获取所有价值（分页格式）', async () => {
      os.core.addValue('勇气', 0.7);
      const res = await app.inject({ method: 'GET', url: '/api/v1/values' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.ok(body.data.length >= 1);
      assert.ok(body.pagination);
      assert.equal(typeof body.pagination.total, 'number');
    });

    it('GET /api/v1/values 支持分页', async () => {
      for (let i = 0; i < 5; i++) {
        os.core.addValue(`价值${i}`, 0.5);
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/values?page=1&pageSize=2' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2);
      assert.equal(body.pagination.total, 5);
      assert.equal(body.pagination.totalPages, 3);
    });

    it('PATCH /api/v1/values/:id 小幅更新直接应用', async () => {
      const value = os.core.addValue('勇气', 0.7);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/values/${value.id}`,
        payload: { weight: 0.8 },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.weight, 0.8);
    });

    it('PATCH /api/v1/values/:id 大幅更新返回 202 待确认', async () => {
      const value = os.core.addValue('勇气', 0.7);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/values/${value.id}`,
        payload: { weight: 0.9 },
      });
      assert.equal(res.statusCode, 202);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id);
      assert.equal(body.data.status, 'pending');
      assert.equal(body.message, '变更需要确认');
    });

    it('PATCH /api/v1/values/:id 不存在返回 404', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/values/nonexistent',
        payload: { weight: 0.5 },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('记忆管理', () => {
    it('POST /api/v1/memories 创建记忆', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        payload: { kind: 'episodic', content: '第一次冒险', valence: 0.5, salience: 0.8 },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.data.kind, 'episodic');
      assert.equal(body.data.content, '第一次冒险');
    });

    it('GET /api/v1/memories 支持分页', async () => {
      for (let i = 0; i < 5; i++) {
        os.core.addMemory('episodic', `记忆${i}`, 0.5, 0.8);
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/memories?page=1&pageSize=2' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2);
      assert.equal(body.pagination.total, 5);
      assert.equal(body.pagination.totalPages, 3);
    });

    it('POST /api/v1/memories/link 关联记忆', async () => {
      const m1 = os.core.addMemory('episodic', '记忆A', 0.5, 0.8);
      const m2 = os.core.addMemory('episodic', '记忆B', 0.3, 0.6);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/link',
        payload: { source: m1.id, target: m2.id, relation: '关联', strength: 0.7 },
      });
      assert.equal(res.statusCode, 201);
    });
  });

  describe('叙事管理', () => {
    it('PUT /api/v1/narrative 更新叙事', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/narrative',
        payload: { content: '新的叙事内容' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.content, '新的叙事内容');
    });

    it('GET /api/v1/narrative 获取叙事', async () => {
      os.core.updateNarrative('已设置的叙事');
      const res = await app.inject({ method: 'GET', url: '/api/v1/narrative' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.content, '已设置的叙事');
    });
  });

  describe('人格管理', () => {
    it('POST /api/v1/personas/fork 创建人格', async () => {
      os.core.addValue('勇气', 0.7);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/personas/fork',
        payload: { label: '探索者', resourceQuota: 0.3 },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.data.label, '探索者');
      assert.equal(body.data.resourceQuota, 0.3);
    });

    it('GET /api/v1/personas 获取所有人格', async () => {
      os.core.addValue('勇气', 0.7);
      os.accelerated.forkPersona('探索者A', new Map([['v1', 0.7]]), 0.2);
      const res = await app.inject({ method: 'GET', url: '/api/v1/personas' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.length >= 1);
    });

    it('GET /api/v1/personas 支持分页', async () => {
      os.core.addValue('勇气', 0.7);
      for (let i = 0; i < 5; i++) {
        os.accelerated.forkPersona(`人格${i}`, new Map([['v1', 0.7]]), 0.1);
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/personas?page=1&pageSize=2' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2);
      assert.equal(body.pagination.total, 5);
      assert.equal(body.pagination.totalPages, 3);
      assert.equal(body.pagination.page, 1);
      assert.equal(body.pagination.pageSize, 2);
    });

    it('GET /api/v1/personas/:id 不存在返回 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/personas/nonexistent' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('快照管理', () => {
    it('POST /api/v1/snapshots 创建快照', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/snapshots',
        payload: { reason: 'manual' },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id);
      assert.equal(body.data.reason, 'manual');
    });

    it('GET /api/v1/snapshots 获取快照列表', async () => {
      os.createSnapshot('manual');
      const res = await app.inject({ method: 'GET', url: '/api/v1/snapshots' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.length >= 1);
    });

    it('GET /api/v1/snapshots 支持分页', async () => {
      for (let i = 0; i < 5; i++) {
        os.createSnapshot('manual');
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/snapshots?page=1&pageSize=3' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 3);
      assert.ok(body.pagination);
      assert.equal(body.pagination.total, 5);
    });

    it('GET /api/v1/snapshots/:id 返回原始 data_json（desktop 本地算 drift 用）', async () => {
      const snap = os.createSnapshot('manual');
      const res = await app.inject({ method: 'GET', url: `/api/v1/snapshots/${snap.id}` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.id, snap.id);
      assert.equal(body.data.reason, 'manual');
      assert.equal(typeof body.data.dataJson, 'string');
      /* dataJson 必须是合法 JSON（desktop 会原样落库后 parse 出 values）。 */
      assert.doesNotThrow(() => JSON.parse(body.data.dataJson));
      assert.equal(typeof body.data.createdAt, 'number');
    });

    it('GET /api/v1/snapshots/:id 未知 id → 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/snapshots/snap_nonexistent' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('操作', () => {
    it('POST /api/v1/operations/evolution/run 运行演化', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/evolution/run',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(typeof body.data.mergedCount, 'number');
    });

    it('POST /api/v1/operations/regulation/run 运行调控', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/regulation/run',
        payload: {},
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.status, 'completed');
    });
  });

  describe('冲突管理', () => {
    it('GET /api/v1/conflicts 获取未解决冲突（分页格式）', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/conflicts' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.ok(body.pagination);
      assert.equal(typeof body.pagination.total, 'number');
    });
  });

  describe('指标端点', () => {
    it('GET /metrics 返回 JSON 指标数据', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(typeof body.uptime_seconds, 'number');
      assert.equal(typeof body.requests.total, 'number');
      assert.ok(body.requests.by_endpoint);
      assert.equal(typeof body.business.persona_count, 'number');
      assert.equal(typeof body.business.conflict_count, 'number');
      assert.equal(typeof body.business.snapshot_count, 'number');
      assert.ok(body.system.memory_mb);
    });

    it('GET /metrics/prometheus 返回 Prometheus 格式', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics/prometheus' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type']?.toString().includes('text/plain'));
      const body = res.body;
      assert.ok(body.includes('chrono_uptime_seconds'));
      assert.ok(body.includes('chrono_http_requests_total'));
      assert.ok(body.includes('chrono_process_memory_bytes'));
      assert.ok(body.includes('chrono_personas_total'));
      assert.ok(body.includes('chrono_conflicts_unresolved'));
      assert.ok(body.includes('chrono_snapshots_total'));
    });
  });

  describe('审计日志端点', () => {
    it('GET /api/v1/audit 无数据库时返回空数组', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/audit' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.data, []);
    });
  });

  describe('API 文档端点', () => {
    it('GET /api/v1/docs 返回 API 文档', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/docs' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data);
      assert.ok(Array.isArray(body.data.endpoints));
      assert.ok(body.data.endpoints.length > 0);
      /* 每个端点都有必填字段 */
      for (const ep of body.data.endpoints) {
        assert.ok(ep.method);
        assert.ok(ep.path);
        assert.ok(ep.description);
      }
    });
  });

  describe('P-OS 人格操作系统', () => {
    it('POST /api/v1/pos/survival 创建生存锚点', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/pos/survival',
        payload: { label: '风险底线', kind: 'threshold', value: 0.2, severity: 4 },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id.startsWith('anchor_'));
      assert.equal(body.data.kind, 'threshold');
      assert.equal(body.data.severity, 4);
    });

    it('GET /api/v1/pos/survival 列出锚点', async () => {
      os.core.addSurvivalAnchor('底线', 'constraint', null, 5);
      const res = await app.inject({ method: 'GET', url: '/api/v1/pos/survival' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1);
    });

    it('PATCH /api/v1/pos/survival/:id 更新锚点（L0 需确认返回 202）', async () => {
      const anchor = os.core.addSurvivalAnchor('底线', 'constraint', null, 3);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/pos/survival/${anchor.id}`,
        payload: { severity: 5 },
      });
      assert.equal(res.statusCode, 202);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id);
      assert.equal(body.data.status, 'pending');
      assert.equal(body.data.layer, 'L0');
      assert.equal(body.message, '变更需要确认');
    });

    it('DELETE /api/v1/pos/survival/:id 删除锚点', async () => {
      const anchor = os.core.addSurvivalAnchor('临时', 'must_have', true, 1);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/pos/survival/${anchor.id}`,
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.deleted, true);
    });

    it('PATCH /api/v1/pos/survival/:id 不存在返回 404', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/pos/survival/nonexistent',
        payload: { severity: 1 },
      });
      assert.equal(res.statusCode, 404);
    });

    it('GET /api/v1/pos/decision-style 获取决策风格', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/pos/decision-style' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(typeof body.data.riskAppetite, 'number');
      assert.equal(typeof body.data.deliberationDepth, 'number');
    });

    it('PUT /api/v1/pos/decision-style 设置决策风格', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/pos/decision-style',
        payload: { riskAppetite: 0.1, lossAversion: 3.0 },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.riskAppetite, 0.1);
      assert.equal(body.data.lossAversion, 3.0);
    });

    it('GET /api/v1/pos/cognitive-model 获取认知模型', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/pos/cognitive-model' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(typeof body.data.attributionStyle, 'number');
    });

    it('PUT /api/v1/pos/cognitive-model 设置认知模型', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/pos/cognitive-model',
        payload: { beliefs: { '努力有回报': 0.8 }, growthMindset: 0.9 },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.beliefs['努力有回报'], 0.8);
      assert.equal(body.data.growthMindset, 0.9);
    });

    it('GET /api/v1/pos/state 获取完整五层状态', async () => {
      os.core.addValue('诚实', 0.8);
      os.core.addSurvivalAnchor('底线', 'constraint', null, 5);
      const res = await app.inject({ method: 'GET', url: '/api/v1/pos/state' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data.L0));
      assert.ok(Array.isArray(body.data.L1));
      assert.ok(body.data.L2);
      assert.ok(body.data.L3);
      assert.ok(body.data.L4);
    });

    it('GET /api/v1/pos/state/summary 获取提示词摘要', async () => {
      os.core.addValue('诚实', 0.8);
      os.core.updateNarrative('测试叙事');
      const res = await app.inject({ method: 'GET', url: '/api/v1/pos/state/summary' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.summary.includes('诚实'));
    });
  });

  describe('错误处理', () => {
    it('域层 RangeError 映射为 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/values',
        payload: { label: '测试', weight: 2.0 },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error);
    });

    it('Zod 验证失败映射为 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/values',
        payload: { label: '', weight: 0.5 },
      });
      assert.equal(res.statusCode, 400);
    });
  });
});

describe('身份与分身 API', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const jwtConfig = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: 'test-secret-32-chars-minimum!!!!!', accessTtlMs: 3600_000, refreshTtlMs: 86400_000 },
  });

  let accessToken: string;
  let tenantId: string;

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config: jwtConfig });

    /* 注册用户（自动创建 Identity + 默认 Avatar） */
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'test@example.com', password: 'password123' },
    });
    const regBody = JSON.parse(regRes.body);
    accessToken = regBody.data.accessToken;
    tenantId = regBody.data.tenantId;
  });

  afterEach(async () => { await app.close(); os.close(); });

  function signUserToken(userId: string, role = 'member'): string {
    return (app as FastifyInstance & {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: userId,
      tenantId,
      role,
      planId: 'free',
    });
  }

  function seedTenantUser(userId: string, email: string): string {
    const now = Date.now();
    os.getDatabase().prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'member', ?, ?, ?)`,
    ).run(userId, email, 'hash', tenantId, now, now);
    const identityService = new IdentityService(os.getDatabase());
    identityService.ensureForUser(userId, tenantId, email.split('@')[0]!);
    return signUserToken(userId);
  }

  it('GET /api/v1/identity 返回注册时创建的身份', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/identity',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.data.id);
    assert.equal(body.data.displayName, 'test');
  });

  it('PATCH /api/v1/identity 更新身份', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/identity',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: '新名字', bio: '自我介绍' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.displayName, '新名字');
    assert.equal(body.data.bio, '自我介绍');
  });

  it('GET /api/v1/avatars 包含默认分身', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].isDefault, true);
    assert.equal(body.data[0].label, '默认');
  });

  it('POST /api/v1/avatars 创建分身', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: '工作模式', kind: 'work' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.data.label, '工作模式');
    assert.equal(body.data.kind, 'work');
    assert.equal(body.data.isDefault, false);
  });

  it('POST /api/v1/avatars 超出 free 配额返回 429', async () => {
    /* free 计划限额 2，默认已占 1，再创建 1 个到达上限 */
    await app.inject({
      method: 'POST',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: '分身1', kind: 'social' },
    });
    /* 第 3 个应超配额 */
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: '分身2', kind: 'family' },
    });
    assert.equal(res.statusCode, 429);
  });

  it('PATCH /api/v1/avatars/:id 更新分身', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: '旧名' },
    });
    const avatarId = JSON.parse(createRes.body).data.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/avatars/${avatarId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: '新名' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).data.label, '新名');
  });

  it('DELETE /api/v1/avatars/:id 软删除分身', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: '临时' },
    });
    const avatarId = JSON.parse(createRes.body).data.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/avatars/${avatarId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(delRes.statusCode, 204);

    /* 删除后查询返回 404 */
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/avatars/${avatarId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(getRes.statusCode, 404);
  });

  it('GET /api/v1/avatars/:id/projection 返回投影状态', async () => {
    /* 先添加价值以确保投影有内容 */
    os.core.addValue('诚实', 0.8);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const defaultAvatar = JSON.parse(listRes.body).data[0];

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/avatars/${defaultAvatar.id}/projection`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.avatarId, defaultAvatar.id);
    assert.ok(body.data.L0);
    assert.ok(body.data.L1);
    assert.ok(body.data.L2);
    assert.ok(body.data.L3);
    assert.ok(body.data.L4);
  });

  it('同租户其他成员拥有独立 identity/avatar 生命周期，且不能访问彼此 avatar', async () => {
    const otherToken = seedTenantUser('user_same_tenant_2', 'other@example.com');

    const ownListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const otherListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${otherToken}` },
    });

    assert.equal(ownListRes.statusCode, 200);
    assert.equal(otherListRes.statusCode, 200);
    const ownAvatarId = JSON.parse(ownListRes.body).data[0].id as string;
    const otherAvatarId = JSON.parse(otherListRes.body).data[0].id as string;
    assert.notEqual(ownAvatarId, otherAvatarId);

    const identities = os.getDatabase().prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM identities WHERE tenant_id = ?',
    ).get(tenantId);
    assert.equal(identities?.count, 2);

    const forbiddenGet = await app.inject({
      method: 'GET',
      url: `/api/v1/avatars/${otherAvatarId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(forbiddenGet.statusCode, 404);

    const forbiddenPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/avatars/${otherAvatarId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: 'should-fail' },
    });
    assert.equal(forbiddenPatch.statusCode, 404);

    const forbiddenProjection = await app.inject({
      method: 'GET',
      url: `/api/v1/avatars/${otherAvatarId}/projection`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(forbiddenProjection.statusCode, 404);
  });

  it('设备绑定同样按 identity 隔离，不能安装其他成员的 avatar', async () => {
    const otherToken = seedTenantUser('user_same_tenant_device', 'device-other@example.com');

    const deviceRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceUid: 'device-uid-1', platform: 'web', pushToken: 'push-1', appVersion: '1.0.0' },
    });
    assert.equal(deviceRes.statusCode, 200);
    const deviceId = JSON.parse(deviceRes.body).data.id as string;

    const ownListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const otherListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/avatars',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    const ownAvatarId = JSON.parse(ownListRes.body).data[0].id as string;
    const otherAvatarId = JSON.parse(otherListRes.body).data[0].id as string;

    const installOtherRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/avatars`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { avatarId: otherAvatarId },
    });
    assert.equal(installOtherRes.statusCode, 404);

    const installOwnRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/avatars`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { avatarId: ownAvatarId },
    });
    assert.equal(installOwnRes.statusCode, 201);

    const listInstalledRes = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/avatars`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(listInstalledRes.statusCode, 200);
    assert.deepEqual(
      JSON.parse(listInstalledRes.body).data.map((item: { id: string }) => item.id),
      [ownAvatarId],
    );
  });
});

describe('API Key 认证', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const authConfig = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    auth: { enabled: true, apiKeys: ['test-key-123'] },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    serverState.ready = true;
    app = await createApp({ os, config: authConfig });
  });

  afterEach(async () => {
    await app.close();
    os.close();
    serverState.ready = false;
    serverState.shuttingDown = false;
  });

  it('无 API Key 的 /api/* 请求返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/values',
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'AUTH_MISSING_KEY');
  });

  it('无效 API Key 返回 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/values',
      headers: { 'x-api-key': 'wrong-key' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'AUTH_INVALID_KEY');
  });

  it('有效 API Key 允许访问', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/values',
      headers: { 'x-api-key': 'test-key-123' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('API Key 不能访问 Persona Core 用户路由', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/persona-core',
      headers: { 'x-api-key': 'test-key-123' },
    });
    assert.equal(listRes.statusCode, 403);
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.code, 'AUTH_INSUFFICIENT_ROLE');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { displayName: 'API Key Persona' },
    });
    assert.equal(createRes.statusCode, 403);
    const createBody = JSON.parse(createRes.body);
    assert.equal(createBody.code, 'AUTH_INSUFFICIENT_ROLE');
  });

  it('公共路径不需要 API Key', async () => {
    const healthRes = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(healthRes.statusCode, 200);

    const readyRes = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(readyRes.statusCode, 200);

    /* JWKS 端点（RFC 8615 well-known）。两个中间件 — jwt-auth 与 auth —
     * 都必须豁免它，否则外部 JWT 验签消费者拿不到公钥。Regression test
     * for NAS deployment where auth.ts had a different PUBLIC_PATHS
     * list than jwt-auth.ts and JWKS returned 401 AUTH_MISSING_KEY. */
    const jwksRes = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    assert.notEqual(jwksRes.statusCode, 401, 'JWKS 不应被 API Key 拦截');
  });

  it('/metrics 端点需要 API Key', async () => {
    const noKeyRes = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(noKeyRes.statusCode, 401);

    const withKeyRes = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-api-key': 'test-key-123' },
    });
    assert.equal(withKeyRes.statusCode, 200);
  });

  it('/metrics 支持 Bearer scrape key 且不放宽普通 Bearer API 访问', async () => {
    await app.close();
    const bearerMetricsConfig = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      auth: {
        enabled: true,
        apiKeys: [],
        metricsApiKeys: ['metrics-scrape-key'],
        requireDbKeys: true,
      },
      jwt: {
        enabled: true,
        secret: 'metrics-bearer-secret-at-least-32-chars',
        issuer: 'test',
      },
    });
    app = await createApp({ os, config: bearerMetricsConfig });

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-scrape-key' },
    });
    assert.equal(metricsRes.statusCode, 200);

    const apiRes = await app.inject({
      method: 'GET',
      url: '/api/v1/values',
      headers: { authorization: 'Bearer metrics-scrape-key' },
    });
    assert.equal(apiRes.statusCode, 401);
  });
});
