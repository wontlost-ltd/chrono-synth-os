/**
 * Redis Fastify 插件
 * 在启动时连接 Redis，关闭时断开连接
 * 提供 app.redis 装饰器
 */

import type { FastifyInstance } from 'fastify';
import type { RedisClient } from '../../cache/redis-client.js';
import type { AppConfig } from '../../config/schema.js';
import { connectRedis, disconnectRedis } from '../../cache/redis-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis?: RedisClient;
  }
}

export async function registerRedis(app: FastifyInstance, config: AppConfig): Promise<void> {
  if (!config.redis.enabled) return;

  try {
    const redis = await connectRedis(config);
    app.decorate('redis', redis);

    app.addHook('onClose', async () => {
      await disconnectRedis();
    });

    app.log.info('Redis 已连接');
  } catch (err) {
    app.log.warn(`Redis 连接失败，降级为无缓存模式: ${err}`);
  }
}
