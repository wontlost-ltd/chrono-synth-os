/**
 * P1-O-abuse — backpressure tenant isolation under realistic load.
 *
 * Unit tests already cover the happy path & basic per-tenant bucket. This
 * integration test verifies that a "noisy neighbor" tenant flooding the
 * server with N concurrent slow requests does NOT degrade a different
 * tenant's success rate or latency above an acceptable threshold.
 *
 * Approach:
 *   1. Mount a slow handler (50ms) behind backpressure capped at 4 per tenant.
 *   2. Tenant A fires 50 concurrent requests → expect ~4 200s + ~46 429s.
 *   3. Tenant B fires 4 concurrent requests **during** A's flood → all 200s.
 *   4. Assert B's worst-case latency stays below ~3× the slow handler delay
 *      (no head-of-line blocking from A).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerBackpressure, type BackpressureController } from '../../server/plugins/backpressure.js';

const SLOW_DELAY_MS = 50;
const CAP_PER_TENANT = 4;
const NOISY_BURST = 50;
const QUIET_BURST = 4;

function makeApp(): { app: ReturnType<typeof Fastify>; ctrl: BackpressureController } {
  const app = Fastify();
  const ctrl = registerBackpressure(app, {
    maxConcurrentPerTenant: CAP_PER_TENANT,
    retryAfterSeconds: 1,
    resolveTenantId: (request: FastifyRequest) =>
      (request.headers['x-tenant-id'] as string) ?? null,
  });
  app.get('/slow', async () => {
    await new Promise(resolve => setTimeout(resolve, SLOW_DELAY_MS));
    return { ok: true };
  });
  return { app, ctrl };
}

async function pollUntilFull(ctrl: BackpressureController, tenant: string, target: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = ctrl.snapshot();
    if ((snap.inFlightByTenant.get(tenant) ?? 0) >= target) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`tenant ${tenant} 在 ${timeoutMs}ms 内未达到 inFlight=${target}`);
}

describe('P1-O-abuse — backpressure under noisy-neighbor load', () => {
  it('noisy tenant A does not starve quiet tenant B', async () => {
    const { app, ctrl } = makeApp();
    try {
      /* 启动 A 的 50 个并发请求，模拟攻击 / 误用流量 */
      const noisyResponses: Promise<{ statusCode: number }>[] = [];
      for (let i = 0; i < NOISY_BURST; i += 1) {
        noisyResponses.push(
          app.inject({ method: 'GET', url: '/slow', headers: { 'x-tenant-id': 'A' } }),
        );
      }
      /* 决定性等待：轮询 backpressure snapshot，直到 A 占满 cap，
       * 而不是用墙钟 sleep（在繁忙 CI 上会 flake）。 */
      await pollUntilFull(ctrl, 'A', CAP_PER_TENANT);

      const startB = Date.now();
      const bResults = await Promise.all(
        Array.from({ length: QUIET_BURST }, () =>
          app.inject({ method: 'GET', url: '/slow', headers: { 'x-tenant-id': 'B' } }),
        ),
      );
      const bElapsedMs = Date.now() - startB;

      /* B 的所有请求必须 200 — 与 A 流量完全无关 */
      for (const res of bResults) {
        assert.equal(res.statusCode, 200, 'tenant B 必须不受 tenant A 阻塞');
      }

      /* B 端到端时间应接近单次 slow 延迟，而不是 A 的累积延迟。
       * 上限设为 3× slow delay：留出测试 jitter，但仍然能识别 head-of-line 阻塞。 */
      assert.ok(
        bElapsedMs < SLOW_DELAY_MS * 3,
        `tenant B 总耗时 ${bElapsedMs}ms 超过 noisy-neighbor 阈值 ${SLOW_DELAY_MS * 3}ms，可能存在跨租户阻塞`,
      );

      const aResults = await Promise.all(noisyResponses);
      const aSuccess = aResults.filter(r => r.statusCode === 200).length;
      const aRejected = aResults.filter(r => r.statusCode === 429).length;

      /* A 的成功数受 cap 控制；后续请求 429 — 注意串行 release 后某些会重试入槽，
       * 因此 success 在 (CAP_PER_TENANT, NOISY_BURST] 之间。最低保证 cap 个；
       * 最大保证不会"全开闸"。 */
      assert.ok(aSuccess >= CAP_PER_TENANT, `tenant A 成功 ${aSuccess} 个 ≥ cap ${CAP_PER_TENANT}`);
      assert.ok(aRejected > 0, 'tenant A 必须至少触发一个 429');
    } finally {
      await app.close();
    }
  });
});
