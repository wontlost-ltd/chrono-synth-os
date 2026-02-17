/**
 * 限流插件
 * 基于 @fastify/rate-limit 实现全局请求限流
 */

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '../../config/schema.js';

export async function registerRateLimit(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindowMs,
    errorResponseBuilder: (_request, context) => ({
      error: 'RateLimitError',
      code: 'RATE_LIMIT_EXCEEDED',
      message: `请求过于频繁，请在 ${Math.ceil(context.ttl / 1000)} 秒后重试`,
    }),
  });
}
