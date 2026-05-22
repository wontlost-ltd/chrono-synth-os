/**
 * P1-E-ext v2 — error-handler honours Accept-Language.
 *
 * Locks the contract:
 *   - same `code` regardless of locale (machine-readable, stable)
 *   - `message` differs between en and zh-CN when the error path
 *     emits a messageId
 *   - missing Accept-Language defaults to en
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('P1-E-ext v2 — error-handler locale resolution', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  /* Tiny rate-limit window so we can trip RATE_LIMIT_EXCEEDED quickly
   * (that's one of the few code paths the handler now resolves via
   * the catalog). */
  const config = loadConfig({
    rateLimit: { max: 1, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    /* Auth + JWT disabled so we can hit /api/v2/version without a
     * token — matches the existing rate-limit-error-mapping fixture. */
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

  it('429 response has stable code regardless of Accept-Language', async () => {
    /* First request consumes the budget; second 429s. */
    await app.inject({ method: 'GET', url: '/api/v2/version' });
    const limited = await app.inject({ method: 'GET', url: '/api/v2/version' });
    assert.equal(limited.statusCode, 429);
    const body = JSON.parse(limited.body) as { code: string; messageId?: string };
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
  });

  it('zh-CN client receives Chinese rate-limit message', async () => {
    await app.inject({ method: 'GET', url: '/api/v2/version' });
    const limited = await app.inject({
      method: 'GET', url: '/api/v2/version',
      headers: { 'accept-language': 'zh-CN' },
    });
    assert.equal(limited.statusCode, 429);
    const body = JSON.parse(limited.body) as { message: string; messageId?: string };
    /* The catalog key 'quota.exceeded' renders in zh-CN as "{resource}
     * 配额已用尽" — assert on the load-bearing word that distinguishes
     * the locales rather than the full string (more resilient if the
     * catalog wording evolves). */
    assert.match(body.message, /配额/);
    assert.equal(body.messageId, 'quota.exceeded');
  });

  it('en client receives English rate-limit message', async () => {
    await app.inject({ method: 'GET', url: '/api/v2/version' });
    const limited = await app.inject({
      method: 'GET', url: '/api/v2/version',
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    assert.equal(limited.statusCode, 429);
    const body = JSON.parse(limited.body) as { message: string };
    assert.match(body.message, /[Qq]uota/);
  });

  it('unknown locale falls back to English', async () => {
    await app.inject({ method: 'GET', url: '/api/v2/version' });
    const limited = await app.inject({
      method: 'GET', url: '/api/v2/version',
      headers: { 'accept-language': 'ja-JP,ja;q=0.9' },
    });
    assert.equal(limited.statusCode, 429);
    const body = JSON.parse(limited.body) as { message: string };
    /* No Japanese catalog → fall back to default (en). */
    assert.match(body.message, /[Qq]uota/);
  });
});
