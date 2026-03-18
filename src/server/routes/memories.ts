/**
 * 记忆管理路由
 * 路由层只做请求解析和响应序列化，业务逻辑委托 MemoryFacade
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import { MemoryFacade } from '../../core/memory-facade.js';
import { CreateMemorySchema, CreatePersonaMemoryRecordSchema, LinkMemorySchema, RelatedMemoryQuerySchema } from '../schemas/api-schemas.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerMemoryRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory, config?: AppConfig): void {
  const facade = new MemoryFacade(os, tenantFactory, config);

  /* POST /api/v1/memories — 创建记忆，限流: 30 次/分钟 */
  app.post('/api/v1/memories', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = request.user as JwtPayload | undefined;
    const jwtUser = user && !user.sub.startsWith('apikey:') ? user : undefined;

    if (jwtUser && typeof request.body === 'object' && request.body !== null) {
      const raw = request.body as Record<string, unknown>;
      if ('personaId' in raw || 'persona_id' in raw || 'memoryType' in raw || 'memory_type' in raw) {
        const body = CreatePersonaMemoryRecordSchema.parse(request.body);
        const result = facade.createPersonaMemory(request.tenantId, jwtUser.sub, {
          personaId: body.personaId ?? body.persona_id!,
          memoryType: body.memoryType ?? body.memory_type!,
          contentText: body.contentText ?? body.content_text!,
          sourceType: body.sourceType ?? body.source_type,
          sourceId: body.sourceId ?? body.source_id,
          sensitivity: body.sensitivity,
        });
        return reply.status(201).send({ data: result });
      }
    }

    const body = CreateMemorySchema.parse(request.body);
    const { memory, indexPromise } = facade.createCoreMemory(request.tenantId, body.kind, body.content, body.valence, body.salience);

    if (indexPromise) {
      indexPromise.catch((err) => {
        app.log.warn({ err, memoryId: memory.id }, '嵌入索引失败');
      });
    }

    return reply.status(201).send({ data: memory });
  });

  /* GET /api/v1/memories — 获取所有记忆（SQL 级分页） */
  app.get('/api/v1/memories', async (request) => {
    const params = parsePagination(request.query as Record<string, unknown>);
    return facade.listMemories(request.tenantId, params.page, params.pageSize);
  });

  /* POST /api/v1/memories/link — 关联记忆 */
  app.post('/api/v1/memories/link', async (request, reply) => {
    const body = LinkMemorySchema.parse(request.body);
    const edge = facade.linkMemories(request.tenantId, body.source, body.target, body.relation, body.strength);
    return reply.status(201).send({ data: edge });
  });

  /* POST /api/v1/memories/decay — 触发全量衰减 */
  app.post('/api/v1/memories/decay', async (request) => {
    return { data: facade.runDecay(request.tenantId) };
  });

  /* POST /api/v1/memories/consolidate — 触发记忆固化 */
  app.post('/api/v1/memories/consolidate', async (request) => {
    return { data: facade.runConsolidation(request.tenantId) };
  });

  /* GET /api/v1/memories/working-set — 获取工作记忆 */
  app.get('/api/v1/memories/working-set', async (request) => {
    return { data: facade.getWorkingMemory(request.tenantId) };
  });

  /* GET /api/v1/memories/:id/related — 获取相关记忆 */
  app.get<{ Params: { id: string } }>('/api/v1/memories/:id/related', async (request) => {
    const { depth } = RelatedMemoryQuerySchema.parse(request.query as Record<string, unknown>);
    return { data: facade.getRelatedMemories(request.tenantId, request.params.id, depth) };
  });

  /* POST /api/v1/memories/:id/activate — 触发扩散激活 */
  app.post<{ Params: { id: string } }>('/api/v1/memories/:id/activate', async (request) => {
    return { data: facade.activateMemory(request.tenantId, request.params.id) };
  });
}
