/**
 * 人生模拟 API 路由
 * POST 创建 → GET 状态 → GET 路径详情 → POST 压力测试
 */

import type { FastifyInstance } from 'fastify';
import type { LifeSimulationService } from '../../simulation/life-simulation-service.js';
import type { LifeSimulationConfig } from '../../types/life-simulation.js';
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import type { AppConfig } from '../../config/schema.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { getPlanLimits } from '../../billing/plans.js';
import { BillingOutbox, billingMetrics } from '../../billing/billing-outbox.js';
import { SubscriptionQueryService } from '../../billing/subscription-query-service.js';
import { NotFoundError, QuotaExceededError, ErrorCode } from '../../errors/index.js';
import {
  CreateLifeSimulationSchema,
  StressTestRequestSchema,
  PaginationQuerySchema,
} from '../schemas/api-schemas.js';

function safeJsonParse(json: string | null | undefined, fallback: unknown = null): unknown {
  if (!json) return fallback;
  try { return JSON.parse(json); }
  catch { return fallback; }
}

/** 人生模拟路由依赖（分片 Phase 0 · Plan 1：resolver 必填；db 存在才启用配额/计量子服务，保持零回归）。 */
export interface LifeSimulationRoutesDeps {
  /** 共享 TenantDbResolver（组合根唯一实例；配额/计量子服务经它路由 shard）。 */
  resolver: TenantDbResolver;
  queueEnabled?: boolean;
  /** 直查用 host db（SubscriptionQueryService 直用，Plan 2）；给定才启用配额/计量。 */
  db?: IDatabase;
  config?: AppConfig;
}

export function registerLifeSimulationRoutes(
  app: FastifyInstance,
  service: LifeSimulationService,
  deps: LifeSimulationRoutesDeps,
): void {
  const asyncMode = deps.queueEnabled ?? false;
  if (!asyncMode && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境禁止同步模拟。请设置 queue.enabled=true 启用异步任务队列以避免 CPU 反压。');
  }
  const { resolver } = deps;
  const optTx = deps.db ? deps.db : undefined;
  /* db 存在才启用配额/计量（保持原「无 db→无配额」语义）；启用时经共享 resolver 按 tenantId 路由 shard。 */
  const quotaManager = optTx ? QuotaManager.fromResolver(resolver) : undefined;
  const usageTracker = optTx ? UsageTracker.fromResolver(resolver) : undefined;
  const billingOutbox = optTx && deps.config ? BillingOutbox.fromResolver(resolver, deps.config) : undefined;
  const subscriptionQuery = optTx ? new SubscriptionQueryService(optTx) : undefined;

  /* GET /api/v1/simulations — 列出租户的所有模拟 */
  app.get('/api/v1/simulations', async (request) => {
    const tenantId = request.tenantId;
    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const offset = (page - 1) * pageSize;

    const { records, total } = service.getByTenantPaginated(tenantId, pageSize, offset);
    return {
      data: records.map(r => ({
        simulationId: r.id,
        status: r.status,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
  });

  /* POST /api/v1/simulations/life — 创建模拟任务（限流: 5 次/分钟） */
  app.post('/api/v1/simulations/life', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = CreateLifeSimulationSchema.parse(request.body);
    const tenantId = request.tenantId;

    /* maxPaths 计划限制检查 */
    if (subscriptionQuery) {
      const planId = subscriptionQuery.getLatestPlanId(tenantId);
      const limits = getPlanLimits(planId);
      const pathCount = Array.isArray((body as Record<string, unknown>).paths)
        ? ((body as Record<string, unknown>).paths as unknown[]).length
        : 0;
      if (limits.maxPaths > 0 && pathCount > limits.maxPaths) {
        throw new QuotaExceededError(`路径数 ${pathCount} 超出计划限制 ${limits.maxPaths}`);
      }
    }

    if (quotaManager && !quotaManager.consumeQuota(tenantId, 'simulation')) {
      throw new QuotaExceededError('模拟次数配额已用尽');
    }

    /* owner_user_id = 发起模拟的登录用户（owner-only 分享鉴权基础）；JWT 关闭时可能无 user → null。 */
    const ownerUserId = (request.user as { sub?: string } | undefined)?.sub ?? null;
    const { simulationId, taskId } = service.enqueue(body, tenantId, undefined, ownerUserId);
    usageTracker?.record(tenantId, 'simulation', 1);

    if (billingOutbox && subscriptionQuery && deps.config?.stripe.enabled) {
      const stripeCustomerId = subscriptionQuery.getActiveStripeCustomerId(tenantId);
      if (stripeCustomerId) {
        /* 仅在实际落库（非幂等去重）时计数，避免重复事件膨胀 meterEventsEnqueued */
        /* ⚠️ simulationId 每次 enqueue 新生成（randomUUID），故它**不提供**跨重试幂等——
         * 它只保证同一次请求内不重复入队。真正的重放防护由全局 Idempotency-Key
         * 插件承担（src/server/plugins/idempotency.ts，默认启用、24h TTL）：
         * 客户端带该 header 时整个 handler（含配额、实体创建、计费）只执行一次。
         * 不带 header 的重放会重复计费——这是**契约要求**，非本层可修。 */
        if (billingOutbox.enqueue(tenantId, stripeCustomerId, 'simulation', 1, simulationId)) {
          billingMetrics.meterEventsEnqueued++;
        }
      }
    }

    if (!asyncMode) {
      try { service.executeTask(simulationId); } catch (e) { app.log.warn({ err: e, simulationId }, '同步执行回退为异步'); }
    }

    return reply.status(202).send({
      data: { simulationId, taskId, status: 'accepted' },
    });
  });

  /* GET /api/v1/simulations/:id — 状态 + 摘要 */
  app.get<{ Params: { id: string } }>('/api/v1/simulations/:id', async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;
    const record = service.getStatus(id, tenantId);
    if (!record) {
      throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
    }

    return {
      data: {
        simulationId: record.id,
        status: record.status,
        progress: safeJsonParse(record.progressJson),
        summary: safeJsonParse(record.summaryJson),
        error: record.error,
        createdAt: record.createdAt,
        completedAt: record.completedAt,
      },
    };
  });

  /* GET /api/v1/simulations/:id/paths/:pathId — 路径时间线 + 分支详情 */
  app.get<{ Params: { id: string; pathId: string } }>(
    '/api/v1/simulations/:id/paths/:pathId',
    async (request) => {
      const { id, pathId } = request.params;
      const tenantId = request.tenantId;
      const pathRecord = service.getPathDetail(id, pathId, tenantId);
      if (!pathRecord) {
        throw new NotFoundError(`路径 ${pathId} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }

      return {
        data: {
          pathId: pathRecord.pathId,
          label: pathRecord.label,
          status: pathRecord.status,
          summary: safeJsonParse(pathRecord.summaryJson),
          timeline: safeJsonParse(pathRecord.timelineJson, []),
          branches: safeJsonParse(pathRecord.branchesJson, []),
        },
      };
    },
  );

  /* POST /api/v1/simulations/:id/stress-test — 压力测试变体（限流: 5 次/分钟） */
  app.post<{ Params: { id: string } }>(
    '/api/v1/simulations/:id/stress-test',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = request.params;
      const body = StressTestRequestSchema.parse(request.body);
      const tenantId = request.tenantId;

      const baseRecord = service.getStatus(id, tenantId);
      if (!baseRecord) {
        throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }

      /* 基于原始配置创建压力测试变体 */
      const baseConfig = safeJsonParse(baseRecord.configJson, {}) as LifeSimulationConfig;

      /* maxPaths 计划限制检查（压力测试沿用原始路径数） */
      if (subscriptionQuery) {
        const planId = subscriptionQuery.getLatestPlanId(tenantId);
        const limits = getPlanLimits(planId);
        const pathCount = Array.isArray(baseConfig.paths) ? baseConfig.paths.length : 0;
        if (limits.maxPaths > 0 && pathCount > limits.maxPaths) {
          throw new QuotaExceededError(`路径数 ${pathCount} 超出计划限制 ${limits.maxPaths}`);
        }
      }

      const stressConfig: LifeSimulationConfig = {
        ...baseConfig,
        stressTestConfig: {
          enabled: true,
          incomeFreezeYears: typeof body.overrides.incomeFreezeYears === 'number'
            ? body.overrides.incomeFreezeYears : 2,
          marketDownturnFactor: typeof body.overrides.marketDownturnFactor === 'number'
            ? body.overrides.marketDownturnFactor : 0.7,
          healthShock: typeof body.overrides.healthShock === 'number'
            ? body.overrides.healthShock : 0.1,
        },
      };

      if (quotaManager && !quotaManager.consumeQuota(tenantId, 'simulation')) {
        throw new QuotaExceededError('模拟次数配额已用尽');
      }

      /* owner_user_id = 发起压力测试的登录用户（变体归属发起者，使其可分享自己的变体）；JWT 关闭 → null。 */
      const ownerUserId = (request.user as { sub?: string } | undefined)?.sub ?? null;
      const { simulationId, taskId } = service.enqueue(stressConfig, tenantId, id, ownerUserId);
      usageTracker?.record(tenantId, 'simulation', 1);

      if (billingOutbox && subscriptionQuery && deps.config?.stripe.enabled) {
        const stripeCustomerId = subscriptionQuery.getActiveStripeCustomerId(tenantId);
        if (stripeCustomerId) {
          /* ⚠️ simulationId 每次 enqueue 新生成（randomUUID），故它**不提供**跨重试幂等——
           * 它只保证同一次请求内不重复入队。真正的重放防护由全局 Idempotency-Key
           * 插件承担（src/server/plugins/idempotency.ts，默认启用、24h TTL）：
           * 客户端带该 header 时整个 handler（含配额、实体创建、计费）只执行一次。
           * 不带 header 的重放会重复计费——这是**契约要求**，非本层可修。 */
          if (billingOutbox.enqueue(tenantId, stripeCustomerId, 'simulation', 1, simulationId)) {
            billingMetrics.meterEventsEnqueued++;
          }
        }
      }

      if (!asyncMode) {
        try { service.executeTask(simulationId); } catch { /* 异步回退 */ }
      }

      return reply.status(202).send({
        data: { simulationId, taskId, baseSimulationId: id, status: 'accepted' },
      });
    },
  );
}
