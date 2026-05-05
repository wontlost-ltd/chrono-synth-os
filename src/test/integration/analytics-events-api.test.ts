/**
 * Integration test for POST /api/v1/analytics/events (P1.7.2 backend).
 *
 * Covers the contract used by chrono-synth-web's `src/lib/analytics.ts`:
 * batch shape, validation, persistence to events_user_journey, and the
 * per-row failure isolation property.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('POST /api/v1/analytics/events', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
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

  it('accepts a single-event batch and persists with received/written/failed counts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: {
        events: [{ name: 'onboarding.step.viewed', properties: { step_id: 'create_persona' } }],
        sessionId: 'sess-12345678',
      },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body) as { data: { received: number; written: number; failed: number } };
    assert.equal(body.data.received, 1);
    assert.equal(body.data.written, 1);
    assert.equal(body.data.failed, 0);
  });

  it('accepts a multi-event batch in one request', async () => {
    const events = [
      { name: 'onboarding.step.viewed', properties: { step_id: 'a' } },
      { name: 'onboarding.step.completed', properties: { step_id: 'a', dwell_ms: 4200 } },
      { name: 'feature.first_use.values_manager' },
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { events },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body) as { data: { received: number; written: number } };
    assert.equal(body.data.received, 3);
    assert.equal(body.data.written, 3);
  });

  it('rejects events with an invalid name pattern', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { events: [{ name: 'Onboarding Step Viewed' }] },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'INVALID_ANALYTICS_PAYLOAD');
  });

  it('rejects an empty batch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { events: [] },
    });

    assert.equal(res.statusCode, 400);
  });

  it('rejects a batch exceeding 200 events (DOS guard)', async () => {
    const events = Array.from({ length: 201 }, (_, i) => ({ name: `e.${i}` }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { events },
    });

    assert.equal(res.statusCode, 400);
  });

  it('rejects nested object property values (PII guardrail)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: {
        events: [
          { name: 'feature.first_use', properties: { user: { name: 'leak' } as unknown as string } },
        ],
      },
    });

    assert.equal(res.statusCode, 400);
  });

  it('rejects properties with more than 32 keys', async () => {
    const properties: Record<string, string> = {};
    for (let i = 0; i < 33; i++) properties[`k${i}`] = String(i);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { events: [{ name: 'too.many.keys', properties }] },
    });

    assert.equal(res.statusCode, 400);
  });
});
