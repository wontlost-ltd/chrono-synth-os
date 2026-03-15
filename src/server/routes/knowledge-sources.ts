/**
 * 知识源管理路由（租户级）
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { KnowledgeSourceStore } from '../../storage/knowledge-source-store.js';
import { CreateKnowledgeSourceSchema, UpdateKnowledgeSourceSchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerKnowledgeSourceRoutes(app: FastifyInstance, db: IDatabase): void {
  const store = new KnowledgeSourceStore(db);

  /* GET /api/v1/knowledge-sources — 列表（租户级） */
  app.get('/api/v1/knowledge-sources', async (request) => {
    const tenantId = request.tenantId;
    const query = request.query as Record<string, unknown>;
    const params = parsePagination(query);
    const offset = (params.page - 1) * params.pageSize;

    const { sources, total } = store.listByTenant(tenantId, params.pageSize, offset);
    return {
      data: sources,
      pagination: { page: params.page, pageSize: params.pageSize, total, totalPages: Math.ceil(total / params.pageSize) || 1 },
    };
  });

  /* GET /api/v1/knowledge-sources/:sourceId — 单条查询 */
  app.get<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId', async (request) => {
    const { sourceId } = request.params;
    const tenantId = request.tenantId;
    const source = store.getById(sourceId, tenantId);
    if (!source) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return { data: source };
  });

  /* POST /api/v1/knowledge-sources — 创建 */
  app.post('/api/v1/knowledge-sources', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const tenantId = request.tenantId;
    const body = CreateKnowledgeSourceSchema.parse(request.body);

    const source = store.create(tenantId, {
      type: body.type,
      name: body.name,
      configJson: JSON.stringify(body.config),
    });

    return reply.status(201).send({ data: source });
  });

  /* PATCH /api/v1/knowledge-sources/:sourceId — 更新 */
  app.patch<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId', async (request) => {
    const { sourceId } = request.params;
    const tenantId = request.tenantId;
    const body = UpdateKnowledgeSourceSchema.parse(request.body);

    const updated = store.update(sourceId, tenantId, {
      name: body.name,
      type: body.type,
      configJson: body.config ? JSON.stringify(body.config) : undefined,
      enabled: body.enabled,
    });

    if (!updated) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return { data: updated };
  });

  /* POST /api/v1/knowledge-sources/:sourceId/sync — 手动触发同步 */
  app.post<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId/sync', async (request) => {
    const { sourceId } = request.params;
    const tenantId = request.tenantId;
    const source = store.getById(sourceId, tenantId);
    if (!source) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    /* 更新 updated_at 作为同步标记；实际摄入由 autorun 异步执行 */
    store.update(sourceId, tenantId, {});
    return { data: { id: sourceId, synced: true } };
  });

  /* DELETE /api/v1/knowledge-sources/:sourceId — 删除 */
  app.delete<{ Params: { sourceId: string } }>('/api/v1/knowledge-sources/:sourceId', async (request) => {
    const { sourceId } = request.params;
    const tenantId = request.tenantId;

    const deleted = store.delete(sourceId, tenantId);
    if (!deleted) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return { data: { id: sourceId } };
  });
}
