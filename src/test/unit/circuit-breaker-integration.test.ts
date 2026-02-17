/**
 * 断路器集成测试：验证 /readyz 在断路器打开时的行为
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { serverState } from '../../server/routes/health.js';
import { CircuitBreaker } from '../../server/plugins/circuit-breaker.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('断路器集成 - /readyz', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let circuitBreaker: CircuitBreaker;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  beforeEach(async () => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
      halfOpenMaxRequests: 1,
    });
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    serverState.ready = true;
    app = await createApp({ os, config, circuitBreaker });
  });

  afterEach(() => {
    os.close();
    serverState.ready = false;
    serverState.shuttingDown = false;
  });

  it('/readyz 正常时返回 database.status=ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.components.database.status, 'ok');
  });

  it('/readyz 断路器打开时返回 database.status=circuit_open', async () => {
    /* 模拟连续失败使断路器打开 */
    for (let i = 0; i < 3; i++) {
      try {
        await circuitBreaker.execute(() => { throw new Error('db fail'); });
      } catch { /* 预期失败 */ }
    }
    assert.equal(circuitBreaker.getState(), 'open');

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.components.database.status, 'circuit_open');
  });

  it('/readyz 在 shuttingDown 时返回 503', async () => {
    serverState.shuttingDown = true;
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'shutting_down');
  });
});
