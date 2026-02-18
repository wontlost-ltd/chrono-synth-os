/**
 * 缓存管理器
 * 提供类型安全的 get/set/invalidate 操作，可选 TTL
 */

import type { RedisClient } from './redis-client.js';

export class CacheManager {
  constructor(private readonly redis: RedisClient) {}

  /** 获取缓存值 */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** 设置缓存值 */
  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs) {
      await this.redis.set(key, serialized, 'PX', ttlMs);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  /** 删除单个键 */
  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /** 按模式批量删除（使用 SCAN 避免阻塞） */
  async invalidatePattern(pattern: string): Promise<number> {
    let deleted = 0;
    const stream = this.redis.scanStream({ match: pattern, count: 100 });
    for await (const keys of stream) {
      if ((keys as string[]).length > 0) {
        deleted += await this.redis.del(...(keys as string[]));
      }
    }
    return deleted;
  }
}
