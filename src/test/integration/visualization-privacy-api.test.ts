import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('可视化与隐私 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    intelligence: { provider: 'mock', model: 'test', embeddingModel: 'mock-embed' },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(() => {
    os.close();
  });

  describe('GET /api/v1/values/visualization', () => {
    it('无价值时返回空节点和边', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/values/visualization' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.nodes.length, 0);
      assert.equal(body.data.edges.length, 0);
      assert.equal(body.data.layout, 'radial');
    });

    it('有价值时返回节点', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addValue('勇气', 0.6);

      const res = await app.inject({ method: 'GET', url: '/api/v1/values/visualization' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.nodes.length, 2);
      assert.ok(body.data.nodes.some((n: { label: string }) => n.label === '诚信'));
    });

    it('共现记忆产生边', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addValue('勇气', 0.6);
      /* 添加一条同时提到两个价值的记忆 */
      os.core.addMemory('episodic', '展现诚信和勇气的时刻', 0.5, 0.5);

      const res = await app.inject({ method: 'GET', url: '/api/v1/values/visualization' });
      const body = JSON.parse(res.body);
      assert.ok(body.data.edges.length > 0);
      assert.equal(body.data.edges[0].weight, 1); /* 唯一的共现，权重为1 */
    });
  });

  describe('GET /api/v1/decisions/:id/fingerprint', () => {
    it('返回决策指纹信息', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/decisions/dec_test/fingerprint' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.caseId, 'dec_test');
    });
  });

  describe('POST /api/v1/privacy/export', () => {
    it('导出所有数据', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addMemory('episodic', '测试记忆', 0.5, 0.5);

      const res = await app.inject({ method: 'POST', url: '/api/v1/privacy/export' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.exportId.startsWith('exp_'));
      assert.equal(body.data.format, 'json');
      assert.ok(body.data.content.persona);
      assert.ok(body.data.exportedAt);
      assert.ok(body.data.tenantId);
    });
  });

  describe('DELETE /api/v1/privacy/data', () => {
    it('删除所有数据', async () => {
      os.core.addValue('诚信', 0.8);
      os.core.addMemory('episodic', '测试记忆', 0.5, 0.5);
      assert.equal(os.core.values.getAll().size, 1);

      const res = await app.inject({ method: 'DELETE', url: '/api/v1/privacy/data' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.deleted, true);
      assert.ok(body.data.timestamp);

      /* 验证数据已清空 */
      assert.equal(os.core.values.getAll().size, 0);
      assert.equal(os.core.memories.getAllMemories().size, 0);
    });
  });

  describe('GET /api/v1/privacy/audit-trail', () => {
    it('返回审计日志', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/privacy/audit-trail' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
    });
  });
});
