/**
 * WebSocket Redis 事件背板**装配**的端到端测试（真 Redis 容器）。
 *
 * ## 与 redis-pubsub-backplane.test.ts 的分工
 *
 * 那条测的是 **ioredis 层**：`publish` / `on('message')` 这套 API 在真 Redis
 * 上的行为（含 RESP2/RESP3 对拍）。它证明不了**本仓的装配是否正确接上**——
 * `registerWebsocket` 里那段 `if (app.redis) { … }` 完全可以写错（订阅错频道、
 * 忘了发布、origin 判据写反）而那条测试照样全绿。
 *
 * 本测试补的就是装配这一层：起**真的 Fastify app**（走 `createApp`），
 * 让它连真 Redis，然后从两个方向验证：
 *
 *   1. **出站**：本地 `os.bus.emit` → 应被发布到 Redis 频道（另一个裸客户端收到）
 *   2. **入站**：别的副本（裸客户端）发布 → 应被 emit 进本地 `os.bus`
 *   3. **自过滤**：本 app 自己发布的消息不得回灌本地 bus（否则事件无限放大）
 *
 * ## 为什么第 3 条最要紧
 *
 * 出站发布与入站消费**接在同一条 bus 上**。若 origin 判据失效，一次本地
 * 事件会：emit → 发布到 Redis → 自己收到 → 再 emit 进 bus → 再发布…
 * 形成**无限放大回环**。这条只有在装配层才测得出来 —— ioredis 层的用例
 * 里两个连接是独立的，根本构不成回环。
 *
 * ⚠️ `processId` 是 websocket.ts 的**模块级常量**，同一进程内所有 app 实例
 * 共享同一个 id。故无法在一个测试进程里起两个「不同副本」的 app —— 对端
 * 副本一律用裸 ioredis 客户端模拟（它可以自由指定 origin）。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { SystemEventName } from '../../types/events.js';

const CHANNEL = 'chrono:events';
/** 用一个真实存在于 VALID_EVENTS 里的事件名——否则会被运行时白名单挡掉。 */
const EVENT: SystemEventName = 'core:memory-added';

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

describe('WebSocket Redis 背板装配（真容器 + 真 app）', () => {
  let container: StartedTestContainer;
  let url: string;
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  /** 模拟「另一个副本」的裸客户端。 */
  let peerPub: Redis;
  let peerSub: Redis;

  before(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;

    /* ⚠️ keyPrefix 必须留空：ioredis 的 keyPrefix **不作用于 pub/sub 频道**，
     * 但本仓生产配置默认 'chrono:'，留空可避免读者误以为频道名带前缀。 */
    const config = loadConfig({
      redis: { enabled: true, url, keyPrefix: '', tls: false },
      websocket: { enabled: true, heartbeatIntervalMs: 30_000 },
      auth: { enabled: false, apiKeys: [], metricsApiKeys: [], requireDbKeys: false },
      jwt: { enabled: false },
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
    });

    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });

    peerPub = new Redis(url, { lazyConnect: true, protocol: 2 });
    await peerPub.connect();
    peerSub = peerPub.duplicate();
    await peerSub.subscribe(CHANNEL);
  });

  after(async () => {
    peerPub?.disconnect();
    peerSub?.disconnect();
    await app?.close();
    os?.close();
    await container?.stop();
  });

  it('★出站：本地 os.bus 事件被发布到 Redis 频道★', async () => {
    const seen: Array<{ event?: string; origin?: string }> = [];
    peerSub.on('message', (_ch: string, msg: string) => {
      seen.push(JSON.parse(msg) as { event?: string; origin?: string });
    });

    os.bus.emit(EVENT, { tenantId: 't1', memoryId: 'm-out' } as never);

    /* 变异实测：把 websocket.ts 里 `redisPub?.publish(...)` 那段删掉 →
     * 本行超时转红（对端永远收不到）。 */
    await waitFor(() => seen.some((m) => m.event === EVENT));
    const msg = seen.find((m) => m.event === EVENT)!;
    assert.ok(msg.origin, '发布的消息必须带 origin（对端靠它自过滤）');
  });

  it('★入站：别的副本发布的事件被 emit 进本地 os.bus★', async () => {
    const received: unknown[] = [];
    const handler = (payload: unknown): void => { received.push(payload); };
    os.bus.on(EVENT, handler as never);

    try {
      await peerPub.publish(CHANNEL, JSON.stringify({
        event: EVENT,
        payload: { tenantId: 't1', memoryId: 'm-in' },
        origin: 'replica-PEER',   // 不是本进程的 processId
      }));

      /* 变异实测：把 `os.bus.emit(...)` 那行删掉 → 本行超时转红。 */
      await waitFor(() => received.length >= 1);
      assert.deepEqual(received[0], { tenantId: 't1', memoryId: 'm-in' }, 'payload 必须原样透传');
    } finally {
      os.bus.off(EVENT, handler as never);
    }
  });

  /* ★这条只有装配层测得出来★
   *
   * 出站发布与入站消费接在**同一条 bus** 上：若 origin 判据失效，
   * 一次本地 emit 会「发布→自己收到→再 emit→再发布…」无限放大。
   * ioredis 层的用例里两个连接互相独立，构不成这个回环。 */
  it('★自过滤：本 app 发布的事件不得回灌本地 bus（防无限放大回环）★', async () => {
    let localCount = 0;
    const handler = (): void => { localCount += 1; };
    os.bus.on(EVENT, handler as never);

    try {
      os.bus.emit(EVENT, { tenantId: 't1', memoryId: 'm-loop' } as never);

      /* 等足够久让「发布 → 自己订阅端收到 → 可能回灌」这一圈跑完。 */
      await new Promise((r) => setTimeout(r, 400));

      /* 变异实测：把 `parsed.origin === processId` 判据去掉 →
       * localCount 变 ≥2（本地 1 次 + 回灌 N 次），本行转红。 */
      assert.equal(localCount, 1, `本地事件只应触发 1 次，实际 ${localCount} 次（>1 = 发生了回灌）`);
    } finally {
      os.bus.off(EVENT, handler as never);
    }
  });

  /* ⚠️ 这条第一版是**假的**：我监听 `EVENT` 却发布伪造事件名，白名单失效时
   * 桥路 emit 的是**那个伪造名**，我的 handler 两种情况下都不会被触发 ——
   * 断言恒成立。变异实测（把 `!VALID_EVENTS.has(...)` 改成 false）时 4/4 全绿，
   * 当场暴露零覆盖。
   *
   * 正解：**监听伪造的那个事件名本身**。白名单生效 → 收不到；失效 → 收到。 */
  it('对照：非白名单事件名不得被 emit 进本地 bus（VALID_EVENTS 守卫）', async () => {
    const FORGED = 'totally:not-a-real-event';
    const forged: unknown[] = [];
    const legit: unknown[] = [];
    const forgedHandler = (): void => { forged.push(1); };
    const legitHandler = (): void => { legit.push(1); };
    os.bus.on(FORGED as SystemEventName, forgedHandler as never);
    os.bus.on(EVENT, legitHandler as never);

    try {
      await peerPub.publish(CHANNEL, JSON.stringify({
        event: FORGED, payload: {}, origin: 'replica-PEER',
      }));
      await new Promise((r) => setTimeout(r, 250));

      /* 变异实测：把 `!VALID_EVENTS.has(parsed.event)` 改成 false → 本行转红。 */
      assert.equal(forged.length, 0, '伪造事件名不得被 emit 进 bus');

      /* 对照：合法事件仍能过 —— 证明上面的 0 不是因为桥路断了。 */
      await peerPub.publish(CHANNEL, JSON.stringify({
        event: EVENT, payload: { tenantId: 't1' }, origin: 'replica-PEER',
      }));
      await waitFor(() => legit.length >= 1);
    } finally {
      os.bus.off(FORGED as SystemEventName, forgedHandler as never);
      os.bus.off(EVENT, legitHandler as never);
    }
  });
});
