/**
 * Redis 跨副本事件背板的真容器集成测试。
 *
 * ## 为什么必须有
 *
 * 2026-09-01 升 ioredis 5→6 时发现：本仓 **Redis 零覆盖** —— CI 没有 redis
 * service，测试里也没有任何 ioredis 用例。而 `server/plugins/websocket.ts`
 * 的跨副本事件背板（多副本部署下事件能否传播的核心路径）正是靠
 * `redisSub.on('message', …)` 收消息的。
 *
 * 后果是：ioredis 6.0.0 唯一的 BREAKING CHANGE 就是**默认改用 RESP3**，
 * 而 RESP3 把 pub/sub 从「`message` 事件」改成协议级 push —— 但**CI 全绿
 * 证明不了这条路径还活着**。当时只能靠钉 `protocol: 2` 保守处理。
 *
 * 本测试补上那个缺口：拿真 Redis 跑一遍「发布 → 另一个连接收到 → 解析」，
 * 让线协议的行为变更**能被 CI 抓住**，而不是等生产事故。
 *
 * ## 覆盖的是生产形状，不是 ioredis 的 API
 *
 * 刻意复刻 websocket.ts 的用法：`duplicate()` 出订阅连接、`subscribe()`、
 * `on('message', …)`、发布侧 `publish(JSON.stringify(...))`，并断言
 * **origin 自过滤**（同一进程发的消息不得被自己回灌）——那是背板防事件
 * 回环的关键，光测「收得到」会漏掉它。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';

const CHANNEL = 'chrono:events';

/** 等一个条件成立，超时即失败——不用固定 sleep（会 flake）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

describe('Redis 跨副本事件背板（真容器）', () => {
  let container: StartedTestContainer;
  let url: string;

  before(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  });

  after(async () => {
    await container?.stop();
  });

  /** 按生产配置建连接（含 protocol 钉版），返回 [发布端, 订阅端]。 */
  async function makePair(protocol: 2 | 3): Promise<[Redis, Redis]> {
    const pub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true, protocol });
    await pub.connect();
    const sub = pub.duplicate();
    return [pub, sub];
  }

  it('★生产形状：publish → 另一连接的 on(message) 收到并可解析★', async () => {
    const [pub, sub] = await makePair(2);
    try {
      const received: Array<{ event?: string; origin?: string }> = [];
      await sub.subscribe(CHANNEL);
      sub.on('message', (_ch: string, msg: string) => {
        received.push(JSON.parse(msg) as { event?: string; origin?: string });
      });

      await pub.publish(CHANNEL, JSON.stringify({ event: 'memory:created', payload: { id: 'm1' }, origin: 'replica-A' }));

      await waitFor(() => received.length >= 1);
      assert.equal(received[0].event, 'memory:created', '事件名必须原样传到对端');
      assert.equal(received[0].origin, 'replica-A');
    } finally {
      pub.disconnect(); sub.disconnect();
    }
  });

  /* ⚠️ 背板必须**自过滤**：本副本发的消息自己也会收到（Redis pub/sub 是广播），
   * websocket.ts 靠 `parsed.origin === processId` 挡掉，否则事件会回灌本地
   * EventBus 造成无限放大。只测「收得到」会漏掉这条。 */
  it('★origin 自过滤：本副本发的消息不得被自己重新投递进 EventBus★', async () => {
    const [pub, sub] = await makePair(2);
    try {
      const SELF = 'replica-SELF';
      const delivered: string[] = [];
      await sub.subscribe(CHANNEL);
      sub.on('message', (_ch: string, msg: string) => {
        const parsed = JSON.parse(msg) as { event?: string; origin?: string };
        /* 复刻 websocket.ts:236 的判据 */
        if (!parsed.event || !parsed.origin || parsed.origin === SELF) return;
        delivered.push(parsed.event);
      });

      await pub.publish(CHANNEL, JSON.stringify({ event: 'self:echo', origin: SELF }));
      await pub.publish(CHANNEL, JSON.stringify({ event: 'peer:event', origin: 'replica-B' }));

      /* 两条都会到达 socket，但只有对端那条该进 EventBus。 */
      await waitFor(() => delivered.length >= 1);
      await new Promise((r) => setTimeout(r, 150));   // 给自发那条留出被误投的机会
      assert.deepEqual(delivered, ['peer:event'], '自发消息必须被 origin 判据挡掉');
    } finally {
      pub.disconnect(); sub.disconnect();
    }
  });

  /* ⚠️ 这条是 #491 钉 `protocol: 2` 的**解除条件**：
   * 当它稳定通过时，说明 RESP3 下 `on('message', …)` 仍然工作，
   * 那时才可以把 redis-client.ts 的 protocol 钉版去掉。
   *
   * 现在就写上而不是等以后：ioredis 再升级时，这条会**第一时间**告诉我们
   * RESP3 到底行不行 —— 而不是像这次一样只能靠读 release note 推断。 */
  it('RESP3（protocol 3）下 pub/sub 是否仍走 on(message)——protocol:2 的解除条件', async () => {
    const [pub, sub] = await makePair(3);
    try {
      const received: string[] = [];
      await sub.subscribe(CHANNEL);
      sub.on('message', (_ch: string, msg: string) => { received.push(msg); });

      await pub.publish(CHANNEL, JSON.stringify({ event: 'resp3:probe', origin: 'replica-A' }));

      await waitFor(() => received.length >= 1);
      assert.equal(received.length, 1, 'RESP3 下 on(message) 仍应收到消息');
    } finally {
      pub.disconnect(); sub.disconnect();
    }
  });

  it('对照：未订阅的频道不得收到消息（防「什么都收」的假通过）', async () => {
    const [pub, sub] = await makePair(2);
    try {
      const received: string[] = [];
      await sub.subscribe(CHANNEL);
      sub.on('message', (_ch: string, msg: string) => { received.push(msg); });

      await pub.publish('chrono:other-channel', JSON.stringify({ event: 'x' }));
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(received.length, 0, '别的频道的消息不得投递过来');
    } finally {
      pub.disconnect(); sub.disconnect();
    }
  });
});
