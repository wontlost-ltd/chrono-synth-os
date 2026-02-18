/**
 * 记忆管理路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { CreateMemorySchema, LinkMemorySchema, RelatedMemoryQuerySchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerMemoryRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* POST /api/v1/memories — 创建记忆 */
  app.post('/api/v1/memories', async (request) => {
    const body = CreateMemorySchema.parse(request.body);
    const tenantOS = getOS(request);
    const memory = tenantOS.core.addMemory(body.kind, body.content, body.valence, body.salience);
    return { data: memory };
  });

  /* GET /api/v1/memories — 获取所有记忆（SQL 级分页） */
  app.get('/api/v1/memories', async (request) => {
    const query = request.query as Record<string, unknown>;
    const tenantOS = getOS(request);
    const params = parsePagination(query);
    const offset = (params.page - 1) * params.pageSize;
    const { nodes, total } = tenantOS.core.memories.getMemoriesPaginated(params.pageSize, offset);
    return {
      data: nodes,
      pagination: { page: params.page, pageSize: params.pageSize, total, totalPages: Math.ceil(total / params.pageSize) || 1 },
    };
  });

  /* POST /api/v1/memories/link — 关联记忆 */
  app.post('/api/v1/memories/link', async (request) => {
    const body = LinkMemorySchema.parse(request.body);
    const tenantOS = getOS(request);
    if (!tenantOS.core.memories.getMemory(body.source)) {
      throw new NotFoundError(`记忆节点 ${body.source} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    if (!tenantOS.core.memories.getMemory(body.target)) {
      throw new NotFoundError(`记忆节点 ${body.target} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    const edge = tenantOS.core.linkMemories(body.source, body.target, body.relation, body.strength);
    return { data: edge };
  });

  /* POST /api/v1/memories/decay — 触发全量衰减 */
  app.post('/api/v1/memories/decay', async (request) => {
    const tenantOS = getOS(request);
    const decayed = tenantOS.core.runMemoryDecay();
    return { data: { decayed, count: decayed.length } };
  });

  /* POST /api/v1/memories/consolidate — 触发记忆固化 */
  app.post('/api/v1/memories/consolidate', async (request) => {
    const tenantOS = getOS(request);
    const consolidated = tenantOS.core.runConsolidation();
    return { data: { consolidated, count: consolidated.length } };
  });

  /* GET /api/v1/memories/working-set — 获取工作记忆 */
  app.get('/api/v1/memories/working-set', async (request) => {
    const tenantOS = getOS(request);
    const slots = tenantOS.core.getWorkingMemory();
    return { data: slots };
  });

  /* GET /api/v1/memories/:id/related — 获取相关记忆 */
  app.get<{ Params: { id: string } }>('/api/v1/memories/:id/related', async (request) => {
    const { id } = request.params;
    const query = request.query as Record<string, unknown>;
    const { depth } = RelatedMemoryQuerySchema.parse(query);
    const tenantOS = getOS(request);

    if (!tenantOS.core.memories.getMemory(id)) {
      throw new NotFoundError(`记忆节点 ${id} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }

    const related = tenantOS.core.memories.getRelatedMemories(id, depth);
    return { data: related };
  });

  /* POST /api/v1/memories/:id/activate — 触发扩散激活 */
  app.post<{ Params: { id: string } }>('/api/v1/memories/:id/activate', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);

    if (!tenantOS.core.memories.getMemory(id)) {
      throw new NotFoundError(`记忆节点 ${id} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }

    const results = tenantOS.core.activateMemory(id);
    return { data: { activations: results, count: results.length } };
  });
}
