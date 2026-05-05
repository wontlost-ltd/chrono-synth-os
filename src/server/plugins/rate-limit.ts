/**
 * 限流插件
 * 基于 @fastify/rate-limit 实现全局请求限流
 * 当 Redis 可用时使用 Redis 存储实现分布式限流
 * 响应头遵循 IETF draft-ietf-httpapi-ratelimit-headers
 * 支持计划感知动态限流：付费计划享有更高配额
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '../../config/schema.js';
import { getPlanLimits } from '../../billing/plans.js';

/** 租户计划限流缓存（避免每次请求查 DB，TTL 5 分钟，最多 10000 条目） */
const PLAN_CACHE_MAX_SIZE = 10_000;
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const planRateLimitCache = new Map<string, { max: number; cachedAt: number }>();

/** 无限制计划使用极高的限额值 */
const UNLIMITED_MAX = 1_000_000;

export async function registerRateLimit(app: FastifyInstance, config: AppConfig): Promise<void> {
  const defaultMax = config.rateLimit.max;

  const options: Parameters<typeof rateLimit>[1] = {
    max: (request: FastifyRequest, _key: string) => {
      const tenantId = (request as { tenantId?: string }).tenantId;
      if (!tenantId || tenantId === 'default') return defaultMax;

      /* 查询缓存 */
      const cached = planRateLimitCache.get(tenantId);
      if (cached && Date.now() - cached.cachedAt < PLAN_CACHE_TTL_MS) return cached.max;

      /* 从请求上下文获取计划信息（JWT payload 中的 planId） */
      const user = (request as unknown as { user?: { planId?: string } }).user;
      const planId = user?.planId;

      /* 仅当有明确的 planId 时才缓存结果；无 planId 时使用默认值不缓存 */
      if (!planId) return defaultMax;

      const limits = getPlanLimits(planId);
      const planMax = limits.rateLimitPerMinute < 0 ? UNLIMITED_MAX : limits.rateLimitPerMinute;

      /* LRU 淘汰：超过上限时清除最旧的 1/4 条目 */
      if (planRateLimitCache.size >= PLAN_CACHE_MAX_SIZE) {
        const toDelete = Math.floor(PLAN_CACHE_MAX_SIZE / 4);
        const iterator = planRateLimitCache.keys();
        for (let i = 0; i < toDelete; i++) {
          const key = iterator.next().value;
          if (key) planRateLimitCache.delete(key);
        }
      }
      planRateLimitCache.set(tenantId, { max: planMax, cachedAt: Date.now() });
      return planMax;
    },
    timeWindow: config.rateLimit.timeWindowMs,
    keyGenerator: (request) => {
      const tenantId = (request as { tenantId?: string }).tenantId;
      return tenantId && tenantId !== 'default' ? tenantId : request.ip;
    },
    /* 确保正常响应也携带限流头（X-RateLimit-Limit/Remaining/Reset） */
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
    errorResponseBuilder: (_request, context) => {
      /* @fastify/rate-limit 在限速触发时会 throw 这个返回值。
       * 必须返回真正的 Error 对象（带 statusCode + code）；返回 plain object
       * 会被全局 setErrorHandler 当作未知错误吞掉，最终客户端拿到 500
       * 而不是 429。曾在 perf 烟测中复现：smoke run 25371205551。 */
      const retryAfterSec = Math.ceil(context.ttl / 1000);
      const err = new Error(`请求过于频繁，请在 ${retryAfterSec} 秒后重试`) as Error & {
        statusCode: number;
        code: string;
        retryAfter: number;
      };
      err.statusCode = context.statusCode;
      err.code = 'RATE_LIMIT_EXCEEDED';
      err.retryAfter = retryAfterSec;
      err.name = 'RateLimitError';
      return err;
    },
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
