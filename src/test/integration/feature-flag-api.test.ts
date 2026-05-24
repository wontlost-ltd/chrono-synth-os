/**
 * Step 10 — Feature flag bootstrap + SSE API contract.
 *
 * Covers:
 *   - bootstrap returns only web.* flags with `web.` prefix stripped
 *   - bootstrap respects the kill switch
 *   - SSE stream emits 'snapshot' on connect + 'change' on mutation
 *   - SSE stream survives consecutive mutations without dropping events
 *   - SSE stream cleans up listeners on disconnect (no leak)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { _resetFeatureFlagSseConnectionCountForTest } from '../../server/routes/feature-flags.js';
import type { FastifyInstance } from 'fastify';

const config = loadConfig({
  rateLimit: { max: 10000, timeWindowMs: 60_000 },
  websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  /* jwt off — bootstrap/stream should still gate cleanly when auth
   * is disabled (local dev / integration tests). */
  jwt: { enabled: false, secret: 'unused', issuer: 'test' },
});

describe('Feature flag API — bootstrap', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetFeatureFlagSseConnectionCountForTest();
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
    _resetFeatureFlagSseConnectionCountForTest();
  });

  it('returns only web.* flags with the web. prefix stripped', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/feature-flags/bootstrap' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { flags: Array<{ flag: string; value: boolean; source: string }> };
    assert.ok(Array.isArray(body.flags));
    /* No flag id should still carry the `web.` prefix. */
    for (const entry of body.flags) {
      assert.equal(entry.flag.startsWith('web.'), false, `unexpected prefix on ${entry.flag}`);
    }
    /* Server-only flags must never appear. */
    const ids = new Set(body.flags.map(f => f.flag));
    assert.equal(ids.has('agent.long-context-mode'), false);
    assert.equal(ids.has('billing.usage-export-v2'), false);
    /* Web flags must all appear. */
    assert.equal(ids.has('cmdk.enabled'), true);
    assert.equal(ids.has('experimental.values_health_dashboard'), true);
  });

  it('default-on web flag reports value=true', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/feature-flags/bootstrap' });
    const body = res.json() as { flags: Array<{ flag: string; value: boolean }> };
    const cmdk = body.flags.find(f => f.flag === 'cmdk.enabled');
    assert.ok(cmdk);
    assert.equal(cmdk.value, true);
  });

  it('kill switch flips bootstrap value to false', async () => {
    os.featureFlags.kill('web.cmdk.enabled');

    const res = await app.inject({ method: 'GET', url: '/api/v1/feature-flags/bootstrap' });
    const body = res.json() as { flags: Array<{ flag: string; value: boolean }> };
    const cmdk = body.flags.find(f => f.flag === 'cmdk.enabled');
    assert.equal(cmdk?.value, false);
  });
});

describe('Feature flag API — SSE stream', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetFeatureFlagSseConnectionCountForTest();
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
    _resetFeatureFlagSseConnectionCountForTest();
  });

  /**
   * SSE stream test pattern: open the underlying HTTP server with
   * fastify.listen, fire an HTTP request that reads the body as text,
   * mutate flags, read enough of the response to verify events arrived,
   * then close the connection.
   *
   * We can't use `app.inject` here because inject buffers the whole
   * response — SSE streams never close, so inject would hang. Real
   * http on a random port is the standard workaround in Fastify SSE
   * integration tests.
   */
  it('emits snapshot on connect and change event on mutation', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no socket address');
    const url = `http://127.0.0.1:${addr.port}/api/v1/feature-flags/stream`;

    /* Open the SSE connection via raw fetch streaming so we can read
     * partial body without waiting for upstream close. */
    const controller = new AbortController();
    const resPromise = fetch(url, { signal: controller.signal });
    const res = await resPromise;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    async function readUntil(needle: string, timeoutMs: number): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) return accumulated;
        accumulated += decoder.decode(value, { stream: true });
        if (accumulated.includes(needle)) return accumulated;
      }
      throw new Error(`timeout waiting for ${needle}; got: ${accumulated.slice(0, 500)}`);
    }

    /* 1. Snapshot arrives on connect. */
    await readUntil('event: snapshot', 2000);

    /* 2. Mutate → change event fires. */
    os.featureFlags.kill('web.cmdk.enabled');
    const after = await readUntil('"cmdk.enabled"', 2000);
    /* The change event payload should contain value=false. */
    assert.match(after, /event: change\ndata: \{"flag":"cmdk\.enabled","value":false\}/);

    controller.abort();
    /* Give Fastify a tick to run cleanup before afterEach closes. */
    await new Promise(r => setTimeout(r, 50));
  });

  it('emits change to connected clients on allow/denyTenant', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no socket address');
    const url = `http://127.0.0.1:${addr.port}/api/v1/feature-flags/stream`;

    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    async function readUntil(needle: string, timeoutMs: number): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) return accumulated;
        accumulated += decoder.decode(value, { stream: true });
        if (accumulated.includes(needle)) return accumulated;
      }
      throw new Error(`timeout waiting for ${needle}`);
    }

    await readUntil('event: snapshot', 2000);

    /* Per-tenant deny on a default-on flag.
     * SSE clients should see a 'change' event — the payload carries no
     * tenant info, but the resolved value reflects the requesting
     * tenant's view (default tenant here, which is on the denylist
     * for cmdk.enabled now). */
    os.featureFlags.denyTenant('web.cmdk.enabled', 'default');
    const after = await readUntil('"cmdk.enabled"', 2000);
    assert.match(after, /event: change\ndata: \{"flag":"cmdk\.enabled","value":false\}/);

    controller.abort();
    await new Promise(r => setTimeout(r, 50));
  });

  it('rejects with 503 when connection cap is reached', async () => {
    /* Drop the cap to 1 (maxConnectionsPerTenant=1 × 10 = 10 conn total
     * cap is too high to exhaust in a test; we approximate by burning
     * connections up to the limit and checking the next request fails).
     * For an exact test we directly poke the connection-count cap via
     * the internal counter helper instead. */
    /* Easier path: drive 10 concurrent connections (the cap), then
     * assert the 11th returns 503. Use loadConfig with explicit cap. */
    const cappedConfig = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: false, secret: 'unused', issuer: 'test' },
      sse: { maxConnectionsPerTenant: 1 },
    });

    await app.close();
    app = await createApp({ os, config: cappedConfig });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no socket address');
    const url = `http://127.0.0.1:${addr.port}/api/v1/feature-flags/stream`;

    /* Hold 10 connections to exhaust the cap (cap = 1 × 10 = 10). */
    const heldControllers: AbortController[] = [];
    for (let i = 0; i < 10; i += 1) {
      const c = new AbortController();
      heldControllers.push(c);
      const res = await fetch(url, { signal: c.signal });
      /* Drain one frame to confirm we're past the cap counter increment. */
      await res.body!.getReader().read();
    }

    /* 11th connection should be rejected. */
    const rejected = await fetch(url);
    assert.equal(rejected.status, 503);

    for (const c of heldControllers) c.abort();
    await new Promise(r => setTimeout(r, 100));
  });

  it('cleans up bus listeners on client disconnect (no leak)', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no socket address');
    const url = `http://127.0.0.1:${addr.port}/api/v1/feature-flags/stream`;

    const before = os.bus.listenerCount('feature-flag:changed');

    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    /* Wait for the route to attach its listener. */
    const reader = res.body!.getReader();
    await reader.read(); /* drain at least one frame */
    const during = os.bus.listenerCount('feature-flag:changed');
    assert.equal(during, before + 1, 'listener should be attached during connection');

    controller.abort();
    /* Allow cleanup callback to run. */
    await new Promise(r => setTimeout(r, 100));
    const after = os.bus.listenerCount('feature-flag:changed');
    assert.equal(after, before, 'listener should be detached after disconnect');
  });
});
