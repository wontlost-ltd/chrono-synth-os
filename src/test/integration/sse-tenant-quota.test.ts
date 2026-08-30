/**
 * SSE 连接配额的**租户隔离**回归测试（审计 #440-3）。
 *
 * 缺陷：`sseConnectionCount` 是单一模块级计数器，准入判据
 * `sseConnectionCount >= maxConns * 10` 里 `maxConns` 却名为
 * `maxConnectionsPerTenant` —— `tenantId` 算出来只用于事件过滤，
 * **从不参与准入**。于是名为 per-tenant 的配额实际是先到先得的公共池：
 * 一个租户开满全局额度，其余所有租户一律 503。
 *
 * 测法：用真实 HTTP 服务器（不能用 `app.inject` —— 它不保持 SSE 流打开，
 * 连接立刻结束、计数立刻归零，测不到"占用"这件事）。
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import {
  getSseConnectionCount,
  getSseConnectionCountForTenant,
  __resetSseConnectionCounts,
} from '../../server/routes/sse.js';

describe('SSE 连接配额按租户隔离（审计 #440-3）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let baseUrl: string;

  /* maxConnectionsPerTenant=2：本租户第 3 条必被拒；
   * 全局上限 = 2*10 = 20，故前两条绝不可能是撞全局上限被拒。 */
  const config = loadConfig({
    sse: { enabled: true, maxConnectionsPerTenant: 2 },
    /* ⚠️ 心跳必须调小：SSE 路由在 writeHead 之后不立刻写内容，客户端的
     * `fetch` 要等到**第一次 keepalive 注释**才拿到响应头并 resolve。
     * 用默认 30s 时每条流的 openStream 实测正好 30020ms，整个文件 283s 超时。 */
    websocket: { enabled: false, heartbeatIntervalMs: 1000 },
    auth: { enabled: false, apiKeys: [], metricsApiKeys: [], requireDbKeys: false },
    jwt: { enabled: false },
    rateLimit: { max: 10_000, timeWindowMs: 60_000 },
  });

  /** 保持打开的连接（用于占用配额），测试结束统一断开。 */
  const open: AbortController[] = [];

  /** 发起一条 SSE 流并**保持打开**；返回状态码。 */
  async function openStream(tenantId: string): Promise<number> {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { 'x-tenant-id': tenantId },
      signal: ac.signal,
    });
    if (res.status === 200) {
      open.push(ac);
      /* 不 await body：SSE 不会结束。读一个 chunk 确认流真的建立了。 */
      void res.body?.getReader().read().catch(() => { /* 断开时的正常错误 */ });
    } else {
      await res.text().catch(() => { /* 忽略 */ });
    }
    return res.status;
  }

  beforeEach(async () => {
    __resetSseConnectionCounts();
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    assert.ok(addr && typeof addr === 'object', '需要真实监听地址');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    /* 先断开全部流并**等服务端真的收到 close**，再关 app。
     * 否则 app.close() 时仍有在途 SSE 响应，Fastify 会在已发头的连接上
     * 再写一次 → ERR_HTTP_HEADERS_SENT 逸出成 uncaughtException。 */
    for (const ac of open) ac.abort();
    open.length = 0;
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
    os.close();
    __resetSseConnectionCounts();
  });

  it('★审计 #440-3：一个租户开满配额不得影响其他租户★', async () => {
    /* 租户 A 开满自己的 2 条。 */
    assert.equal(await openStream('tenant-a'), 200, 'A 第 1 条应成功');
    assert.equal(await openStream('tenant-a'), 200, 'A 第 2 条应成功');
    assert.equal(getSseConnectionCountForTenant('tenant-a'), 2, 'A 占用 2 条');

    /* A 超配额 → 只拒 A。 */
    assert.equal(await openStream('tenant-a'), 503, 'A 第 3 条必须被拒（超本租户配额）');

    /* ★核心断言★：B 完全没用过配额，必须能连。
     * 变异实测：判据退回单一全局计数器（`sseConnectionCount >= maxConns*10`）时，
     * 本行仍是 200（因为全局上限 20 没满）——所以光有这一条**测不出**原缺陷，
     * 必须配下面那条「全局池被吃满」的用例。 */
    assert.equal(await openStream('tenant-b'), 200, 'B 不该被 A 的用量牵连');
    assert.equal(getSseConnectionCountForTenant('tenant-b'), 1);
  });

  it('★审计 #440-3：A 吃满全局池后 B 仍须可连（原缺陷的直接复现）★', async () => {
    /* 原判据是 `sseConnectionCount >= maxConns * 10`，即全局 20 条。
     * 缺陷版下 A 可以一路开到 20 条（per-tenant 完全不设防），
     * 第 21 条起**所有租户**都 503。
     *
     * 修复后 A 在第 3 条就被本租户配额拦下，全局池根本吃不满，
     * B 自然不受影响。故本用例断言的是「A 最多只能占 maxConns 条」。 */
    let aOk = 0;
    for (let i = 0; i < 20; i++) {
      if (await openStream('tenant-a') === 200) aOk += 1;
    }

    /* 变异实测：判据退回单一全局计数器 → aOk = 20，本行转红。 */
    assert.equal(aOk, 2, 'A 最多只能占用 maxConnectionsPerTenant(=2) 条');
    assert.ok(getSseConnectionCount() < 20, '全局池不该被单一租户吃满');

    /* 而 B 照常可连——缺陷版下这里会是 503。 */
    assert.equal(await openStream('tenant-b'), 200, 'B 必须不受 A 的用量影响');
  });

  it('对照：断开后名额必须释放（否则配额只减不增，等于慢性拒绝服务）', async () => {
    assert.equal(await openStream('tenant-c'), 200);
    assert.equal(await openStream('tenant-c'), 200);
    assert.equal(await openStream('tenant-c'), 503, '满额');

    /* 断开一条，等服务端收到 close。 */
    open.pop()!.abort();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(getSseConnectionCountForTenant('tenant-c'), 1, '释放后应剩 1');
    assert.equal(await openStream('tenant-c'), 200, '释放出的名额必须可再用');
  });
});
