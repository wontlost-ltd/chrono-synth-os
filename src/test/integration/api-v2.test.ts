import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('API v2 coexistence', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(() => {
    os.close();
  });

  it('serves v2 health with version negotiation headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/health' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-api-version'], '2');
    assert.equal(res.headers['x-api-min-supported'], '1');
    assert.deepEqual(JSON.parse(res.body), {
      status: 'ok',
      apiVersion: 2,
      minSupportedVersion: 1,
    });
  });

  it('serves v2 version info alongside v1 routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/version' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      current: 2,
      supported: [1, 2],
      deprecationNotice: null,
    });
  });

  it('v1 healthz route does not have X-API-Version header', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    assert.equal(res.headers['x-api-version'], undefined);
  });

  it('unknown v2 path returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/does-not-exist' });

    assert.equal(res.statusCode, 404);
  });
});
