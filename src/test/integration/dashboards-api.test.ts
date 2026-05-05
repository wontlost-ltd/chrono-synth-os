/**
 * Integration test for the P2.7 dashboards endpoint.
 *
 * Locks down the JSON shape that chrono-synth-web's PersonaHealth
 * scaffold reads. Real aggregation (d7 / d30 historical comparison)
 * lands in a follow-up PR; this test pins the contract against the
 * stub so the frontend doesn't break when historical data arrives.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('GET /api/v1/admin/dashboards/persona/:personaId', () => {
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

  it('returns the canonical PersonaHealth shape for an unknown persona', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboards/persona/unknown-persona-id',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      data: { personaId: string; values: Array<{ label: string; current: number }>; generatedAt: number };
    };
    assert.equal(body.data.personaId, 'unknown-persona-id');
    assert.ok(Array.isArray(body.data.values));
    assert.equal(body.data.values.length, 0);
    assert.equal(typeof body.data.generatedAt, 'number');
    assert.ok(body.data.generatedAt > 0);
  });
});
