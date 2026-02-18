/**
 * 人生模拟 API 路由
 * POST 创建 → GET 状态 → GET 路径详情 → POST 压力测试
 */

import type { FastifyInstance } from 'fastify';
import type { LifeSimulationService } from '../../simulation/life-simulation-service.js';
import type { LifeSimulationConfig } from '../../types/life-simulation.js';
import type { IDatabase } from '../../storage/database.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
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

export function registerLifeSimulationRoutes(
  app: FastifyInstance,
  service: LifeSimulationService,
  options?: { queueEnabled?: boolean; db?: IDatabase },
): void {
  const asyncMode = options?.queueEnabled ?? false;
  const quotaManager = options?.db ? new QuotaManager(options.db) : undefined;
  const usageTracker = options?.db ? new UsageTracker(options.db) : undefined;

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

  /* POST /api/v1/simulations/life — 创建模拟任务 */
  app.post('/api/v1/simulations/life', async (request, reply) => {
    const body = CreateLifeSimulationSchema.parse(request.body);
    const tenantId = request.tenantId;

    if (quotaManager && !quotaManager.consumeQuota(tenantId, 'simulation')) {
      throw new QuotaExceededError('模拟次数配额已用尽');
    }

    const { simulationId, taskId } = service.enqueue(body, tenantId);
    usageTracker?.record(tenantId, 'simulation', 1);

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

  /* POST /api/v1/simulations/:id/stress-test — 压力测试变体 */
  app.post<{ Params: { id: string } }>(
    '/api/v1/simulations/:id/stress-test',
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

      const { simulationId, taskId } = service.enqueue(stressConfig, tenantId, id);
      usageTracker?.record(tenantId, 'simulation', 1);

      if (!asyncMode) {
        try { service.executeTask(simulationId); } catch { /* 异步回退 */ }
      }

      return reply.status(202).send({
        data: { simulationId, taskId, baseSimulationId: id, status: 'accepted' },
      });
    },
  );
}
