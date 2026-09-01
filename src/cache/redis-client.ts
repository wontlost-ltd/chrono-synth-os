/**
 * Redis 客户端封装
 * 提供连接管理、健康检查和优雅关闭
 */

import { Redis } from 'ioredis';
import type { AppConfig } from '../config/schema.js';

let redisInstance: Redis | null = null;

export type RedisClient = Redis;

/** 创建或获取 Redis 单例连接 */
export function getRedis(config: AppConfig): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(config.redis.url, {
      keyPrefix: config.redis.keyPrefix,
      tls: config.redis.tls ? {} : undefined,
      retryStrategy(times: number) {
        return Math.min(times * 200, 30_000);
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      /* ioredis 6.0.0 起默认改用 RESP3（唯一的 BREAKING CHANGE；另一条
       * Node ≥20 我们已满足）。#491 升级时本仓 **Redis 零覆盖**，无法验证
       * RESP3 下 `server/plugins/websocket.ts` 的跨副本背板
       * （`redisSub.on('message', …)`）是否还工作，故保守钉了 `protocol: 2`。
       *
       * ⚠️ 现已用真 Redis 容器实测（`src/test/integration/redis-pubsub-backplane.test.ts`）：
       * **RESP3 下 `on('message', …)` 与 RESP2 行为一致**，两种协议下发一条
       * publish 都恰好收到 1 次 message 事件 —— ioredis 把协议级 push 归一
       * 回了同一套事件 API。当时「pub/sub 会变成 push 而收不到」的担心不成立。
       *
       * 那为什么仍然保留这行？因为**钉版本身是有价值的显式契约**：
       * 生产用的线协议不该随依赖升级被静默切换（RESP3 还会改 map/set 等
       * 回复的形状，本仓今天没用到，不代表将来不会）。上面那条测试同时覆盖
       * RESP2 与 RESP3，所以哪天想切只需改这一个数字，且**改完立刻有测试作证**。 */
      protocol: 2,
    });
  }
  return redisInstance;
}

/** 连接 Redis */
export async function connectRedis(config: AppConfig): Promise<Redis> {
  const redis = getRedis(config);
  await redis.connect();
  return redis;
}

/** 健康检查 */
export async function redisHealthCheck(redis: Redis): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/** 优雅关闭 */
export async function disconnectRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
