/**
 * 记忆管理路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { CreateMemorySchema, LinkMemorySchema } from '../schemas/api-schemas.js';
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
    /* 验证 source 和 target 存在，避免 FK 违约冒泡为 500 */
    if (!os.core.memories.getMemory(body.source)) {
      throw new NotFoundError(`记忆节点 ${body.source} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    if (!os.core.memories.getMemory(body.target)) {
      throw new NotFoundError(`记忆节点 ${body.target} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    const edge = os.core.linkMemories(body.source, body.target, body.relation, body.strength);
    return { data: edge };
  });
}
