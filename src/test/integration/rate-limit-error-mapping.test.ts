/**
 * 限流错误映射集成测试。
 *
 * 回归用例：rate-limit.ts 的 errorResponseBuilder 必须返回真正的 Error
 * 对象，否则全局 setErrorHandler 会将 plain object 当成未知错误吞掉，
 * 客户端最终拿到 500 而不是 429。该 bug 在 P1.6 perf 烟测中被复现
 * （run 25371205551，conversation route 100% 返回 500）。
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('Rate limit → 429 mapping', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  /* 极低阈值便于快速触顶；timeWindow 1 分钟保证在测试时长内不会重置。 */
  const config = loadConfig({
    rateLimit: { max: 2, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    auth: { enabled: false, apiKeys: [], metricsApiKeys: [], requireDbKeys: false },
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

  it('returns 429 (not 500) when global rate limit is exceeded', async () => {
    /* 选一个肯定走全局限流但不依赖 fixture 的端点。/api/v2/health 受限流，
     * 但豁免端点（/healthz）不受。这里用 /api/v2/version 触顶。 */
    const url = '/api/v2/version';

    /* 前两次必须 200，第三次必须 429。 */
    const r1 = await app.inject({ method: 'GET', url });
    const r2 = await app.inject({ method: 'GET', url });
    const r3 = await app.inject({ method: 'GET', url });

    assert.equal(r1.statusCode, 200, 'first request should pass');
    assert.equal(r2.statusCode, 200, 'second request should pass');
    assert.equal(r3.statusCode, 429, 'third request should be rate-limited (regression: was 500)');

    const body = JSON.parse(r3.body) as {
      error: string;
      code: string;
      message: string;
      retryAfter: number;
    };
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(body.error, 'RateLimitError');
    assert.match(body.message, /\d+\s*秒/);
    assert.ok(typeof body.retryAfter === 'number' && body.retryAfter > 0,
      'retryAfter should be a positive number of seconds');
  });

  it('rate-limit response includes IETF retry-after header', async () => {
    const url = '/api/v2/version';
    await app.inject({ method: 'GET', url });
    await app.inject({ method: 'GET', url });
    const limited = await app.inject({ method: 'GET', url });

    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers['retry-after'], 'retry-after header should be set');
    /* x-ratelimit-* 系列由 addHeaders 配置注入；不强校验值，只验证存在。 */
    assert.ok(limited.headers['x-ratelimit-limit'], 'x-ratelimit-limit header should be set');
  });
});
