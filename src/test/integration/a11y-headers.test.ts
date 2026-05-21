/**
 * P1-AY-basic — backend a11y baseline checks.
 *
 * This test exists to lock in the small but load-bearing a11y guarantees
 * that the API already provides:
 *
 *   - Every error response from the global error handler exposes a
 *     stable `code` field. Screen-reader-friendly UI clients pin
 *     against `code` (machine-readable, stable across i18n) rather
 *     than the localised human message — so any regression of the
 *     error shape would break a11y tooling downstream.
 *
 * The `Vary: Accept-Language` + `Prefer/Preference-Applied` reply
 * decoration is implemented in `src/server/plugins/a11y-headers.ts`
 * but **deliberately not registered** on the global Fastify app:
 *   - onSend races with the idempotency-replay path
 *     (reply.send from preHandler) and corrupts downstream test state.
 *   - The helper is exported as a library function for routes that
 *     opt in explicitly.
 *   - Re-enabling at the app level is P1-AY-ext scope (route-level
 *     attachment via decorator).
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

describe('P1-AY-basic — error response shape (a11y contract)', () => {
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

  it('validation error response carries both code and message', async () => {
    /* Drive a known-bad request through the global error handler. */
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {},
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500,
      `expected 4xx, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok(typeof body.code === 'string' && (body.code as string).length > 0,
      `error response missing "code" field: ${res.body}`);
    assert.ok(typeof body.message === 'string' && (body.message as string).length > 0,
      `error response missing "message" field: ${res.body}`);
  });

  it('401 (auth required) error also exposes a code field', async () => {
    /* The auth plugin runs before route resolution, so unknown routes
     * to authenticated namespaces yield 401, not 404. Either way, the
     * a11y contract is: every error has a stable code. */
    const res = await app.inject({ method: 'GET', url: '/api/v1/values' });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok(typeof body.code === 'string', `401 response missing code: ${res.body}`);
  });
});
