/**
 * P1-T-edge — security headers integration test.
 *
 * Verifies the OWASP API baseline headers are present on every
 * response.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

describe('P1-T-edge — OWASP baseline headers', () => {
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

  it('every response carries Strict-Transport-Security', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const hsts = res.headers['strict-transport-security'];
    assert.ok(hsts, 'HSTS header missing');
    assert.match(String(hsts), /max-age=31536000/);
    assert.match(String(hsts), /includeSubDomains/);
  });

  it('Referrer-Policy is no-referrer', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });

  it('X-Content-Type-Options is nosniff', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('X-Frame-Options is DENY', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('Cross-Origin-Opener-Policy + Resource-Policy are same-origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  });

  it('X-Permitted-Cross-Domain-Policies is none', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['x-permitted-cross-domain-policies'], 'none');
  });
});
