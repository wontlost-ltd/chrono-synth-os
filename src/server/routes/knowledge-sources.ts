/**
 * 知识源管理路由（租户级）
 * 路由层只做请求解析和响应序列化，业务逻辑委托 KnowledgeSourceService
 */

import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import { CreateKnowledgeSourceSchema, UpdateKnowledgeSourceSchema } from '../schemas/api-schemas.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerKnowledgeSourceRoutes(app: FastifyInstance, services: AppServices): void {
  const { knowledgeSource: service } = services;

  /* GET /api/v1/knowledge-sources — 列表（租户级） */
  app.get('/api/v1/knowledge-sources', async (request) => {
    const params = parsePagination(request.query as Record<string, unknown>);
    const result = service.list(request.tenantId, params.page, params.pageSize);
    return { data: result.data, pagination: result.pagination };
  });

  /* GET /api/v1/knowledge-sources/:sourceId — 单条查询 */
  app.get<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId', async (request) => {
    return { data: service.getById(request.tenantId, request.params.sourceId) };
  });

  /* POST /api/v1/knowledge-sources — 创建 */
  app.post('/api/v1/knowledge-sources', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = CreateKnowledgeSourceSchema.parse(request.body);
    const source = service.create(request.tenantId, {
      type: body.type,
      name: body.name,
      config: body.config,
    });
    return reply.status(201).send({ data: source });
  });

  /* PATCH /api/v1/knowledge-sources/:sourceId — 更新 */
  app.patch<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId', async (request) => {
    const body = UpdateKnowledgeSourceSchema.parse(request.body);
    return { data: service.update(request.tenantId, request.params.sourceId, {
      name: body.name,
      type: body.type,
      config: body.config,
      enabled: body.enabled,
    }) };
  });

  /* POST /api/v1/knowledge-sources/:sourceId/sync — 手动触发同步 */
  app.post<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId/sync', async (request) => {
    return { data: service.sync(request.tenantId, request.params.sourceId) };
  });

  /* DELETE /api/v1/knowledge-sources/:sourceId — 删除 */
  app.delete<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId', async (request) => {
    return { data: service.delete(request.tenantId, request.params.sourceId) };
  });
}
