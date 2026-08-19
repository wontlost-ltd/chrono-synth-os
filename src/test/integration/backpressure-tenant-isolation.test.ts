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
 *   4. Assert B 的请求**进入 handler 的等待时间**极短（未被 A 挡在准入层外）。
 *
 * ⚠️ 这里刻意测「进入 handler 的偏移」而**不是**端到端耗时。
 *
 * 旧版断言 `bElapsedMs < SLOW_DELAY_MS * 3`，实测 15 次跑挂 7 次，且失败值呈
 * 双峰（~52ms 正常，或 152/237/355/455ms）而非渐变抖动。归因结论：
 *
 *   - B 进入 handler 的偏移**恒为 0~1ms**、且始终全部 200——准入层从未阻塞 B；
 *   - 延迟全部发生在**进入 handler 之后**，即 handler 里的 `setTimeout(50)`
 *     被事件循环推迟；
 *   - 决定性实验：**完全不发 B 请求**，只跑 A 的 50 个 inject，同时测一个裸
 *     `setTimeout(50)`，实际耗时同样飙到 276~455ms。
 *
 * 也就是说端到端耗时测的是**宿主机事件循环调度延迟**（50 个 inject 在单线程上
 * 排队，其中 46 个走 429 分支），与租户隔离没有因果关系。被测代码侧也已核对：
 * backpressure 的计数器严格按 tenantId 分桶，A 的 429 路径不碰 B 的 state，
 * 结构上不存在跨租户阻塞。
 *
 * 故改为断言隔离性本身：B 能否**立即获得准入**。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerBackpressure, type BackpressureController } from '../../server/plugins/backpressure.js';

const SLOW_DELAY_MS = 50;
const CAP_PER_TENANT = 4;
const NOISY_BURST = 50;
const QUIET_BURST = 4;

/** handler 入口打点：记录每个租户的请求**实际进入 handler**的时刻。 */
interface HandlerEntry { readonly tenant: string; readonly at: number }

function makeApp(): {
  app: ReturnType<typeof Fastify>;
  ctrl: BackpressureController;
  entries: HandlerEntry[];
} {
  const app = Fastify();
  const entries: HandlerEntry[] = [];
  const ctrl = registerBackpressure(app, {
    maxConcurrentPerTenant: CAP_PER_TENANT,
    retryAfterSeconds: 1,
    resolveTenantId: (request: FastifyRequest) =>
      (request.headers['x-tenant-id'] as string) ?? null,
  });
  app.get('/slow', async (request: FastifyRequest) => {
    entries.push({ tenant: (request.headers['x-tenant-id'] as string) ?? '?', at: Date.now() });
    await new Promise(resolve => setTimeout(resolve, SLOW_DELAY_MS));
    return { ok: true };
  });
  return { app, ctrl, entries };
}

/**
 * 轮询到某租户占满 cap 为止。
 *
 * ⚠️ 两个细节都来自实测（否则 25 次里仍会偶发挂一次）：
 *   - 用 `setTimeout(0)` 而不是 `setImmediate`：**降低忙轮询强度**。
 *     （注：`setImmediate` 回调结束后事件循环仍会进入下一轮 timer 阶段，
 *     并不会「饿死」timer；紧密的 check 阶段轮询是在和 50 个 inject 抢
 *     调度，实测把整轮拖慢。）
 *   - 超时给到 5s：50 个 inject 同时排队时，事件循环调度延迟实测可达 455ms，
 *     1s 预算在慢机器/繁忙 CI 上余量不足。这是纯等待上限，不影响正常路径耗时；
 *     真 hang 仍会失败，只是从约 1s 变成最多 5s 才报出来。
 */
async function pollUntilFull(ctrl: BackpressureController, tenant: string, target: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = ctrl.snapshot();
    if ((snap.inFlightByTenant.get(tenant) ?? 0) >= target) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`tenant ${tenant} 在 ${timeoutMs}ms 内未达到 inFlight=${target}`);
}

describe('P1-O-abuse — backpressure under noisy-neighbor load', () => {
  it('noisy tenant A does not starve quiet tenant B', async () => {
    const { app, ctrl, entries } = makeApp();
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

      /* B 的所有请求必须 200 — 与 A 流量完全无关 */
      for (const res of bResults) {
        assert.equal(res.statusCode, 200, 'tenant B 必须不受 tenant A 阻塞');
      }

      /* 隔离性的直接判据：B 的每个请求都必须**立即获得准入**（进入 handler），
       * 而不是排在 A 后面等。实测该偏移恒为 0~1ms；若准入层真的跨租户阻塞，
       * B 会被迫等 A 的 slot 释放，偏移将至少是一个 SLOW_DELAY_MS 量级。
       *
       * 阈值取 SLOW_DELAY_MS/2 = 25ms，是**经验性检测边界**，不是从控制流推出的
       * 二分证明：实测偏移恒为 0~1ms（留足调度余量），而「被迫等一轮 A」需要约
       * 50ms，25ms 落在这两个实测量级之间。
       *
       * ⚠️ 别把它读成「0~25ms 之间不可能有值」——那只对「全局 slot、必须等 A
       * 完整释放」这一种故障模型成立。共享锁提前释放、准入前几毫秒同步阻塞等
       * 部分等待，都会落在 25ms 以内（见下方盲区）。
       *
       * 已知盲区（变异实测）：
       *   - 跨租户延迟 <25ms 的缺陷只有约 2/5 概率检出；
       *   - slot 泄漏（计数器只增不减）本测试看不到——由 backpressure 单测
       *     的 exactly-once 用例覆盖。 */
      const bEntryOffsets = entries.filter(e => e.tenant === 'B').map(e => e.at - startB);
      /* 这条 length 断言不可删：若 B 一个都没进 handler（例如被全量 429），
       * 下面基于偏移的断言在**空集上恒真**，缺陷会被静默放过。
       * （下面改用 every() 而非 `Math.max(...[])`，避免再依赖 -Infinity 的
       * 空集语义——但空集本身仍需本条来拦。） */
      assert.equal(
        bEntryOffsets.length,
        QUIET_BURST,
        `tenant B 应有 ${QUIET_BURST} 个请求进入 handler，实际 ${bEntryOffsets.length} 个`,
      );
      assert.ok(
        bEntryOffsets.every(ms => ms < SLOW_DELAY_MS / 2),
        `tenant B 进入 handler 的偏移 [${bEntryOffsets.join(', ')}]ms 中存在 ≥ `
        + `${SLOW_DELAY_MS / 2}ms 的样本，说明准入层存在跨租户阻塞`,
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
