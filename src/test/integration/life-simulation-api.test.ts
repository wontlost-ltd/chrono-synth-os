import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('人生模拟 API 集成测试', () => {
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

    /* 准备 L0-L1 数据 */
    os.core.addValue('财务安全', 0.8);
    os.core.addValue('个人成长', 0.6);
    os.core.addSurvivalAnchor('收入底线', 'threshold', 100000, 4);

    app = await createApp({ os, config });
  });

  afterEach(() => {
    os.close();
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
    horizonYears: 3,
    age: 35,
  };

  it('POST /api/v1/simulations/life 返回 202', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulations/life',
      payload: BODY,
    });
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.ok(body.data.simulationId);
    assert.ok(body.data.taskId);
    assert.equal(body.data.status, 'accepted');
  });

  it('GET /api/v1/simulations/:id 返回模拟状态', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/simulations/life', payload: BODY,
    });
    const { simulationId } = JSON.parse(createRes.body).data;

    const res = await app.inject({
      method: 'GET', url: `/api/v1/simulations/${simulationId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.simulationId, simulationId);
    assert.ok(['pending', 'running', 'completed'].includes(body.data.status));
  });

  it('GET /api/v1/simulations/:id 完成后有摘要', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/simulations/life', payload: BODY,
    });
    const { simulationId } = JSON.parse(createRes.body).data;

    const res = await app.inject({
      method: 'GET', url: `/api/v1/simulations/${simulationId}`,
    });
    const body = JSON.parse(res.body);
    if (body.data.status === 'completed') {
      assert.ok(body.data.summary);
      assert.ok(body.data.summary.recommendedPathId);
      assert.ok(body.data.summary.paths.length === 2);
    }
  });

  it('GET /api/v1/simulations/:id/paths/:pathId 返回路径详情', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/simulations/life', payload: BODY,
    });
    const { simulationId } = JSON.parse(createRes.body).data;

    const res = await app.inject({
      method: 'GET', url: `/api/v1/simulations/${simulationId}/paths/stable`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.pathId, 'stable');
    assert.ok(body.data.timeline);
    assert.ok(Array.isArray(body.data.timeline));
  });

  it('GET /api/v1/simulations/unknown 返回 404', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/simulations/unknown_id',
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST stress-test 创建变体', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/simulations/life', payload: BODY,
    });
    const { simulationId } = JSON.parse(createRes.body).data;

    const stressRes = await app.inject({
      method: 'POST',
      url: `/api/v1/simulations/${simulationId}/stress-test`,
      payload: {
        variantLabel: '经济衰退',
        overrides: { marketDownturnFactor: 0.5, incomeFreezeYears: 3 },
      },
    });
    assert.equal(stressRes.statusCode, 202);
    const body = JSON.parse(stressRes.body);
    assert.ok(body.data.simulationId);
    assert.equal(body.data.baseSimulationId, simulationId);
  });

  it('验证请求校验：少于 2 条路径返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulations/life',
      payload: {
        paths: [{ id: 'only', label: '只有一条', initialConditions: {} }],
        horizonYears: 5,
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('验证请求校验：horizonYears 超过 30 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulations/life',
      payload: { ...BODY, horizonYears: 50 },
    });
    assert.equal(res.statusCode, 400);
  });
});
