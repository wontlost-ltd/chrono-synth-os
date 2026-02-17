/**
 * 记忆管理路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { CreateMemorySchema, LinkMemorySchema, RelatedMemoryQuerySchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

export function registerMemoryRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* POST /api/v1/memories — 创建记忆 */
  app.post('/api/v1/memories', async (request) => {
    const body = CreateMemorySchema.parse(request.body);
    const memory = os.core.addMemory(body.kind, body.content, body.valence, body.salience);
    return { data: memory };
  });

  /* GET /api/v1/memories — 获取所有记忆（统一分页响应） */
  app.get('/api/v1/memories', async (request) => {
    const query = request.query as Record<string, unknown>;
    const all = os.core.memories.getAllMemories();
    const items = [...all.values()];
    const params = parsePagination(query);
    return paginate(items, params);
  });

  /* POST /api/v1/memories/link — 关联记忆 */
  app.post('/api/v1/memories/link', async (request) => {
    const body = LinkMemorySchema.parse(request.body);
    if (!os.core.memories.getMemory(body.source)) {
      throw new NotFoundError(`记忆节点 ${body.source} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    if (!os.core.memories.getMemory(body.target)) {
      throw new NotFoundError(`记忆节点 ${body.target} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    const edge = os.core.linkMemories(body.source, body.target, body.relation, body.strength);
    return { data: edge };
  });

  /* POST /api/v1/memories/decay — 触发全量衰减 */
  app.post('/api/v1/memories/decay', async () => {
    const decayed = os.core.runMemoryDecay();
    return { data: { decayed, count: decayed.length } };
  });

  /* POST /api/v1/memories/consolidate — 触发记忆固化 */
  app.post('/api/v1/memories/consolidate', async () => {
    const consolidated = os.core.runConsolidation();
    return { data: { consolidated, count: consolidated.length } };
  });

  /* GET /api/v1/memories/working-set — 获取工作记忆 */
  app.get('/api/v1/memories/working-set', async () => {
    const slots = os.core.getWorkingMemory();
    return { data: slots };
  });

  /* GET /api/v1/memories/:id/related — 获取相关记忆 */
  app.get('/api/v1/memories/:id/related', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const { depth } = RelatedMemoryQuerySchema.parse(query);

    if (!os.core.memories.getMemory(id)) {
      throw new NotFoundError(`记忆节点 ${id} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }

    const related = os.core.memories.getRelatedMemories(id, depth);
    return { data: related };
  });

  /* POST /api/v1/memories/:id/activate — 触发扩散激活 */
  app.post('/api/v1/memories/:id/activate', async (request) => {
    const { id } = request.params as { id: string };

    if (!os.core.memories.getMemory(id)) {
      throw new NotFoundError(`记忆节点 ${id} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }

    const results = os.core.activateMemory(id);
    return { data: { activations: results, count: results.length } };
  });
}
