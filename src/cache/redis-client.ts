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
      /* ⚠️ ioredis 6.0.0 起**默认改用 RESP3**（唯一的 BREAKING CHANGE，
       * 另一条 Node ≥20 我们已满足）。RESP3 会改变部分回复的形状，其中
       * pub/sub 从「`message` 事件」变成协议级 push —— 而
       * `server/plugins/websocket.ts` 的跨副本事件背板正是靠
       * `redisSub.on('message', …)` 收消息的。
       *
       * 本仓 **Redis 零覆盖**：CI 没有 redis service，测试里也没有任何
       * ioredis 用例。也就是说 CI 全绿**证明不了** RESP3 下 pub/sub 仍然工作。
       * 在没有验证手段的前提下跟着默认走等于拿生产赌运气。
       *
       * 故显式钉 `protocol: 2` 保持 v5 线协议（官方 release note 明确给出
       * 的退路），先拿到 6.x 的连接韧性与安全修复；等补上真 Redis 的
       * pub/sub 集成测试后，再单独一个 PR 切 RESP3 并用那条测试验证。 */
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
