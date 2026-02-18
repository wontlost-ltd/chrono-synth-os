/**
 * 人生模拟 API 路由
 * POST 创建 → GET 状态 → GET 路径详情 → POST 压力测试
 */

import type { FastifyInstance } from 'fastify';
import type { LifeSimulationService } from '../../simulation/life-simulation-service.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import {
  CreateLifeSimulationSchema,
  StressTestRequestSchema,
} from '../schemas/api-schemas.js';

export function registerLifeSimulationRoutes(
  app: FastifyInstance,
  service: LifeSimulationService,
  options?: { queueEnabled?: boolean },
): void {
  const asyncMode = options?.queueEnabled ?? false;

  /* GET /api/v1/simulations — 列出租户的所有模拟 */
  app.get('/api/v1/simulations', async (request) => {
    const tenantId = request.tenantId;
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10) || 20));
    const records = service.getByTenant(tenantId, limit);
    return {
      data: records.map(r => ({
        simulationId: r.id,
        status: r.status,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
    };
  });

  /* POST /api/v1/simulations/life — 创建模拟任务 */
  app.post('/api/v1/simulations/life', async (request, reply) => {
    const body = CreateLifeSimulationSchema.parse(request.body);
    const tenantId = request.tenantId;
    const { simulationId, taskId } = service.enqueue(body, tenantId);

    if (!asyncMode) {
      try { service.executeTask(simulationId); } catch { /* 异步回退 */ }
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
        progress: record.progressJson ? JSON.parse(record.progressJson) : null,
        summary: record.summaryJson ? JSON.parse(record.summaryJson) : null,
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
          summary: pathRecord.summaryJson ? JSON.parse(pathRecord.summaryJson) : null,
          timeline: pathRecord.timelineJson ? JSON.parse(pathRecord.timelineJson) : [],
          branches: pathRecord.branchesJson ? JSON.parse(pathRecord.branchesJson) : [],
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
      const baseConfig = JSON.parse(baseRecord.configJson);
      const stressConfig = {
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

      const { simulationId, taskId } = service.enqueue(stressConfig, tenantId, id);

      if (!asyncMode) {
        try { service.executeTask(simulationId); } catch { /* 异步回退 */ }
      }

      return reply.status(202).send({
        data: { simulationId, taskId, baseSimulationId: id, status: 'accepted' },
      });
    },
  );
}
