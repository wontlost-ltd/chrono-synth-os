/**
 * 限流插件
 * 基于 @fastify/rate-limit 实现全局请求限流
 * 当 Redis 可用时使用 Redis 存储实现分布式限流
 * 响应头遵循 IETF draft-ietf-httpapi-ratelimit-headers
 */

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '../../config/schema.js';

export async function registerRateLimit(app: FastifyInstance, config: AppConfig): Promise<void> {
  const options: Parameters<typeof rateLimit>[1] = {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindowMs,
    keyGenerator: (request) => {
      const tenantId = (request as { tenantId?: string }).tenantId;
      return tenantId && tenantId !== 'default' ? tenantId : request.ip;
    },
    /* 确保正常响应也携带限流头（X-RateLimit-Limit/Remaining/Reset） */
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
    errorResponseBuilder: (_request, context) => ({
      error: 'RateLimitError',
      code: 'RATE_LIMIT_EXCEEDED',
      message: `请求过于频繁，请在 ${Math.ceil(context.ttl / 1000)} 秒后重试`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  };

  /* 当 Redis 可用时使用 Redis 存储（分布式限流） */
  if (app.redis) {
    options.redis = app.redis;
  } else if (process.env.NODE_ENV === 'production' && process.env.REPLICA_COUNT && Number(process.env.REPLICA_COUNT) > 1) {
    throw new Error('多副本生产环境必须配置 Redis 以启用分布式限流。当前 REPLICA_COUNT > 1 但 Redis 未配置。');
  } else if (process.env.NODE_ENV === 'production') {
    console.warn('[WARN] Redis 未配置，限流为单进程模式。多副本部署建议配置 Redis 以启用分布式限流。');
  }

  await app.register(rateLimit, options);
}
