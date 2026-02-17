/**
 * 快照管理路由
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { CreateSnapshotSchema } from '../schemas/api-schemas.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

export function registerSnapshotRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* POST /api/v1/snapshots — 创建快照 */
  app.post('/api/v1/snapshots', async (request) => {
    const body = CreateSnapshotSchema.parse(request.body ?? {});
    const snapshot = os.createSnapshot(body.reason);
    return { data: { id: snapshot.id, reason: snapshot.reason, createdAt: snapshot.createdAt } };
  });

  /* GET /api/v1/snapshots — 获取快照列表（支持分页） */
  app.get<{ Querystring: Record<string, unknown> }>('/api/v1/snapshots', async (request) => {
    const list = os.snapshots.list();
    const params = parsePagination(request.query);
    return paginate(list, params);
  });

  /* POST /api/v1/snapshots/:id/restore — 从快照恢复 */
  app.post<{ Params: { id: string } }>('/api/v1/snapshots/:id/restore', async (request) => {
    const { id } = request.params;
    const ok = os.restoreFromSnapshot(id);
    if (!ok) {
      throw new NotFoundError(`快照 ${id} 不存在或恢复失败`, ErrorCode.NOT_FOUND_SNAPSHOT);
    }
    return { data: { restored: true, snapshotId: id } };
  });
}
