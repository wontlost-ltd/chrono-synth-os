/**
 * P1-O-abuse — per-tenant concurrent-request backpressure plugin tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerBackpressure, DEFAULT_BACKPRESSURE } from '../../server/plugins/backpressure.js';

function makeApp(maxConcurrent: number, tenantOf?: (r: FastifyRequest) => string | null) {
  const app = Fastify();
  const ctrl = registerBackpressure(app, {
    maxConcurrentPerTenant: maxConcurrent,
    retryAfterSeconds: DEFAULT_BACKPRESSURE.retryAfterSeconds,
    resolveTenantId: tenantOf ?? ((r: FastifyRequest) => (r.headers['x-tenant-id'] as string) ?? null),
  });
  /* Slow handler that lets us hold N concurrent. */
  app.get('/slow', async (request) => {
    const delay = Number((request.query as { delay?: string }).delay ?? 50);
    await new Promise(resolve => setTimeout(resolve, delay));
    return { ok: true };
  });
  return { app, ctrl };
}

describe('backpressure', () => {
  it('admits requests under the per-tenant cap', async () => {
    const { app } = makeApp(3);
    try {
      const res = await app.inject({ method: 'GET', url: '/slow', headers: { 'x-tenant-id': 't1' } });
      assert.equal(res.statusCode, 200);
    } finally { await app.close(); }
  });

  it('rejects with 429 once cap is exceeded; carries Retry-After header', async () => {
    const { app } = makeApp(1);
    try {
      /* Fire two in parallel; the second should be rejected. */
      const slow = app.inject({ method: 'GET', url: '/slow?delay=100', headers: { 'x-tenant-id': 't1' } });
      /* Tiny pause to let the first request occupy the slot */
      await new Promise(resolve => setTimeout(resolve, 10));
      const second = await app.inject({ method: 'GET', url: '/slow?delay=10', headers: { 'x-tenant-id': 't1' } });
      assert.equal(second.statusCode, 429);
      assert.equal(second.headers['retry-after'], String(DEFAULT_BACKPRESSURE.retryAfterSeconds));
      const body = JSON.parse(second.body) as { code: string };
      assert.equal(body.code, 'TENANT_CONCURRENCY_LIMIT');
      await slow;
    } finally { await app.close(); }
  });

  it('releases the slot after the response finishes (sequential bursts work)', async () => {
    const { app } = makeApp(1);
    try {
      /* Three back-to-back requests; each waits for the previous. */
      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({ method: 'GET', url: '/slow?delay=10', headers: { 'x-tenant-id': 't1' } });
        assert.equal(res.statusCode, 200, `request ${i} should succeed once the prior slot freed`);
      }
    } finally { await app.close(); }
  });

  it('isolates tenants: t1 hitting cap does NOT throttle t2', async () => {
    const { app } = makeApp(1);
    try {
      const t1Slow = app.inject({ method: 'GET', url: '/slow?delay=100', headers: { 'x-tenant-id': 't1' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      const t2 = await app.inject({ method: 'GET', url: '/slow?delay=10', headers: { 'x-tenant-id': 't2' } });
      assert.equal(t2.statusCode, 200, 't2 has its own bucket and should succeed');
      await t1Slow;
    } finally { await app.close(); }
  });

  it('skips backpressure when tenant resolver returns null (anonymous traffic)', async () => {
    const { app } = makeApp(1, () => null);
    try {
      const a = app.inject({ method: 'GET', url: '/slow?delay=50' });
      const b = await app.inject({ method: 'GET', url: '/slow?delay=10' });
      /* Both succeed: with no tenant id, the plugin opts out. */
      assert.equal(b.statusCode, 200);
      await a;
    } finally { await app.close(); }
  });

  it('handler errors release the slot via onError hook', async () => {
    const app = Fastify();
    registerBackpressure(app, {
      maxConcurrentPerTenant: 1,
      retryAfterSeconds: 1,
      resolveTenantId: r => (r.headers['x-tenant-id'] as string) ?? null,
    });
    app.get('/boom', async () => { throw new Error('boom'); });
    try {
      const first = await app.inject({ method: 'GET', url: '/boom', headers: { 'x-tenant-id': 't1' } });
      assert.equal(first.statusCode, 500);
      /* Second request must succeed — slot freed by onError */
      const second = await app.inject({ method: 'GET', url: '/boom', headers: { 'x-tenant-id': 't1' } });
      assert.equal(second.statusCode, 500, 'expected 500 from boom; failure here would suggest 429 -> slot leaked');
    } finally { await app.close(); }
  });

  it('抛错的请求只释放一次 slot——不得连带释放别人的（exactly-once）', async () => {
    /* 回归测试：onError 与 onResponse 都会为**同一个**抛错请求触发。
     * 若释放时不清 `_backpressureTenant` 标记，就会减两次，把仍在途的
     * X 的 slot 一并释放掉——计数偏低、租户可突破 cap，滥用保护静默失效。
     * `Math.max(0, …)` 只防负数，防不住这个，所以必须并发地测。
     *
     * 既有的 error 测试是**串行**的（只验证 slot 有被还回来），检不出多还。 */
    const { app, ctrl } = makeApp(2);
    let releaseHeld: (() => void) | undefined;
    /* 用 barrier 而不是 sleep：等「X 真的进了 handler」「Y 的 onResponse 真的跑完」，
     * 而不是猜多少毫秒够。否则这个测试自己就成了墙钟依赖的 flaky 测试。 */
    let heldEntered: () => void;
    const xInHandler = new Promise<void>(resolve => { heldEntered = resolve; });
    app.get('/hold', async () => {
      heldEntered();
      await new Promise<void>(resolve => { releaseHeld = resolve; });
      return { ok: true };
    });
    app.get('/boom', async () => { throw new Error('boom'); });
    /* 注册在 backpressure 的 onResponse **之后**，故它跑到时释放已完成。 */
    let boomSettled: () => void;
    const yReleased = new Promise<void>(resolve => { boomSettled = resolve; });
    app.addHook('onResponse', async (request) => {
      if (request.url === '/boom') boomSettled();
    });
    try {
      /* X 一直在途，稳稳占住 1 个 slot */
      const held = app.inject({ method: 'GET', url: '/hold', headers: { 'x-tenant-id': 't1' } });
      await xInHandler;
      assert.equal(ctrl.snapshot().inFlightByTenant.get('t1'), 1, 'X 应占住 1 个 slot');

      /* Y 抛错：onError + onResponse 双触发 */
      const boom = await app.inject({ method: 'GET', url: '/boom', headers: { 'x-tenant-id': 't1' } });
      assert.equal(boom.statusCode, 500);
      await yReleased;

      assert.equal(
        ctrl.snapshot().inFlightByTenant.get('t1') ?? 0,
        1,
        'Y 抛错后 X 仍在途，计数必须仍为 1；若为 0 说明 Y 释放了两次、连带释放了 X 的 slot',
      );

      /* 不止看诊断 snapshot，还要验**对外行为**：cap=2 且 X 仍占 1，
       * 那么再来一个请求应当被放行（占满），而第四个必须 429。 */
      const boom2 = await app.inject({ method: 'GET', url: '/boom', headers: { 'x-tenant-id': 't1' } });
      assert.equal(boom2.statusCode, 500, 'cap 还剩 1 个位，Z 应被放行（500 而非 429）');

      releaseHeld?.();
      await held;
      assert.equal(ctrl.snapshot().totalInFlight, 0, '全部结束后计数应归零');
    } finally { await app.close(); }
  });

  it('snapshot reports in-flight counts per tenant', async () => {
    const { app, ctrl } = makeApp(5);
    try {
      const pending = app.inject({ method: 'GET', url: '/slow?delay=80', headers: { 'x-tenant-id': 't1' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      const snap = ctrl.snapshot();
      assert.equal(snap.inFlightByTenant.get('t1'), 1);
      assert.equal(snap.totalInFlight, 1);
      await pending;
      /* After settle, the map should be empty. */
      const snap2 = ctrl.snapshot();
      assert.equal(snap2.totalInFlight, 0);
    } finally { await app.close(); }
  });
});
