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
