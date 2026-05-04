import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('人生模拟可视化 API', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let simulationId: string;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  const BODY = {
    paths: [
      {
        id: 'stable', label: '稳定路径', description: '保持现状',
        initialConditions: { income: 300000, savings: 500000 },
        branches: [],
      },
      {
        id: 'startup', label: '创业路径', description: '全职创业',
        initialConditions: { income: 0, savings: 300000, incomeMultiplier: 0 },
        branches: [
          { label: '成功', probability: 0.4, conditions: { incomeOverride: 600000 } },
          { label: '失败', probability: 0.6, conditions: { incomeOverride: 0 } },
        ],
      },
    ],
    horizonYears: 5,
    age: 35,
  };

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    os.core.addValue('财务安全', 0.8);
    os.core.addValue('个人成长', 0.6);
    os.core.addSurvivalAnchor('收入底线', 'threshold', 100000, 4);
    app = await createApp({ os, config });

    /* 创建一个已完成的模拟 */
    const res = await app.inject({ method: 'POST', url: '/api/v1/simulations/life', payload: BODY });
    simulationId = JSON.parse(res.body).data.simulationId;
  });

  afterEach(async () => { await app.close(); os.close(); });

  /* ── overview ── */
  describe('GET /visualization/overview', () => {
    it('完成后返回摘要', async () => {
      const res = await app.inject({ url: `/api/v1/simulations/${simulationId}/visualization/overview` });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.recommendedPathId);
      assert.ok(body.data.retrospective);
      assert.ok(Array.isArray(body.data.paths));
      assert.strictEqual(body.data.meta.horizonYears, 5);
    });

    it('不存在返回 404', async () => {
      const res = await app.inject({ url: '/api/v1/simulations/nonexistent/visualization/overview' });
      assert.strictEqual(res.statusCode, 404);
    });

    it('meta 包含 baseSimulationId 和 completedAt', async () => {
      const res = await app.inject({ url: `/api/v1/simulations/${simulationId}/visualization/overview` });
      const body = JSON.parse(res.body);
      assert.strictEqual(body.data.meta.baseSimulationId, null);
      assert.ok(typeof body.data.meta.completedAt === 'number');
    });
  });

  /* ── paths ── */
  describe('GET /visualization/paths', () => {
    it('多路径对齐数据', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/paths?metrics=wealth,healthIndex&resolution=year`,
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.data.series.length, 2);
      assert.deepStrictEqual(body.data.metrics, ['wealth', 'healthIndex']);
      assert.strictEqual(body.data.resolution, 'year');
      for (const s of body.data.series) {
        assert.ok(s.points.length > 0);
        assert.ok(s.stats.min);
      }
    });

    it('默认指标（核心 4 个）+ metricMeta', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/paths`,
      });
      const body = JSON.parse(res.body);
      assert.strictEqual(body.data.metrics.length, 4);
      assert.strictEqual(body.data.metricMeta.length, 4);
      for (const meta of body.data.metricMeta) {
        assert.ok(meta.key, 'metricMeta 应包含 key');
        assert.ok(meta.label, 'metricMeta 应包含 label');
        assert.ok(Array.isArray(meta.range), 'metricMeta 应包含 range');
      }
    });

    it('无效指标返回 400', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/paths?metrics=wealth,bogusMetric`,
      });
      assert.strictEqual(res.statusCode, 400);
    });

    it('resolution=2y 下采样', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/paths?resolution=2y`,
      });
      const body = JSON.parse(res.body);
      /* 5 年的时间线以 step=2 下采样，应为 3 个桶 (1-2, 3-4, 5) */
      for (const s of body.data.series) {
        assert.ok(s.points.length <= 3);
      }
    });
  });

  /* ── branches ── */
  describe('GET /visualization/branches/:pathId', () => {
    it('有分支的路径返回 graph 结构', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/branches/startup`,
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.graph.nodes.length >= 2);
      assert.ok(body.data.graph.edges.length >= 1);
      assert.strictEqual(body.data.pathId, 'startup');
      /* 所有 edge 都有 value 字段（Sankey 兼容） */
      for (const edge of body.data.graph.edges) {
        assert.ok(typeof edge.value === 'number', `edge ${edge.source}→${edge.target} 缺少 value`);
      }
    });

    it('无分支的路径返回空 branches 数组', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/branches/stable`,
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.data.branches.length, 0);
    });

    it('不存在的路径返回 404', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/branches/nonexistent`,
      });
      assert.strictEqual(res.statusCode, 404);
    });
  });

  /* ── stress-comparison ── */
  describe('GET /visualization/stress-comparison', () => {
    it('无变体返回空列表 + baseSummary 结构完整', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/stress-comparison`,
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body.data.variants, []);
      assert.ok(body.data.baseSummary);
      assert.ok(body.data.baseSummary.recommendedPathId);
      assert.ok(Array.isArray(body.data.baseSummary.paths));
      assert.strictEqual(body.data.baseSimulationId, simulationId);
    });

    it('有变体返回 deltas', async () => {
      /* 先创建一个压力测试变体 */
      await app.inject({
        method: 'POST',
        url: `/api/v1/simulations/${simulationId}/stress-test`,
        payload: { variantLabel: '压力', overrides: { incomeFreezeYears: 2, marketDownturnFactor: 0.5, healthShock: 0.2 } },
      });

      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/stress-comparison`,
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.data.variants.length, 1);
      assert.ok(body.data.variants[0].deltas.length > 0);
    });
  });

  /* ── milestones ── */
  describe('GET /visualization/milestones', () => {
    it('返回峰值/谷值事件', async () => {
      const res = await app.inject({
        url: `/api/v1/simulations/${simulationId}/visualization/milestones?metrics=wealth,healthIndex`,
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.data.milestones.length, 2);
      for (const m of body.data.milestones) {
        assert.ok(m.events.length > 0, `路径 ${m.pathId} 应有里程碑事件`);
        assert.ok(m.summary.startSnapshot);
        assert.ok(m.summary.endSnapshot);
      }
    });
  });

  /* ── 租户隔离 ── */
  describe('租户隔离', () => {
    it('不同 OS 实例看不到其他实例的模拟', async () => {
      /* 创建独立 OS 实例（独立数据库），其中不存在当前 simulationId */
      const clock = new TestClock(1000);
      const logger = new SilentLogger();
      const otherOs = new ChronoSynthOS({ clock, logger });
      otherOs.start();
      otherOs.core.addValue('测试', 0.5);
      const otherApp = await createApp({ os: otherOs, config });
      try {
        const res = await otherApp.inject({
          url: `/api/v1/simulations/${simulationId}/visualization/overview`,
        });
        assert.strictEqual(res.statusCode, 404);
      } finally {
        otherOs.close();
      }
    });
  });
});
