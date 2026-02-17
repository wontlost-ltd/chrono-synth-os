/**
 * 冲突管理路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { ResolveConflictSchema } from '../schemas/api-schemas.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

export function registerConflictRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* GET /api/v1/conflicts — 获取所有未解决冲突（统一分页响应） */
  app.get('/api/v1/conflicts', async (request) => {
    const query = request.query as Record<string, unknown>;
    const conflicts = os.meta.conflicts.getUnresolved();
    const params = parsePagination(query);
    return paginate(conflicts, params);
  });

  /* PATCH /api/v1/conflicts/:id/resolve — 解决冲突 */
  app.patch<{ Params: { id: string } }>('/api/v1/conflicts/:id/resolve', async (request) => {
    const { id } = request.params;
    const body = ResolveConflictSchema.parse(request.body);
    const ok = os.meta.resolveConflict(id, body.resolution);
    if (!ok) {
      throw new NotFoundError(`冲突 ${id} 不存在或已解决`, ErrorCode.NOT_FOUND_CONFLICT);
    }
    return { data: { id, resolved: true, resolution: body.resolution } };
  });
}
