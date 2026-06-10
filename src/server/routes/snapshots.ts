/**
 * 快照管理路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { CreateSnapshotSchema } from '../schemas/api-schemas.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

export function registerSnapshotRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* POST /api/v1/snapshots — 创建快照 */
  app.post('/api/v1/snapshots', async (request, reply) => {
    const body = CreateSnapshotSchema.parse(request.body ?? {});
    const tenantOS = getOS(request);
    const snapshot = tenantOS.createSnapshot(body.reason);
    return reply.status(201).send({ data: { id: snapshot.id, reason: snapshot.reason, createdAt: snapshot.createdAt } });
  });

  /* GET /api/v1/snapshots — 获取快照列表（支持分页） */
  app.get<{ Querystring: Record<string, unknown> }>('/api/v1/snapshots', async (request) => {
    const tenantOS = getOS(request);
    const list = tenantOS.snapshots.list();
    const params = parsePagination(request.query);
    return paginate(list, params);
  });

  /* GET /api/v1/snapshots/:id — 获取单个快照的原始数据（含 data_json）。
   * desktop 同步用：列表只给元数据，本地算 drift 需要 data_json 里的 values。复用 store.loadRaw。 */
  app.get<{ Params: { id: string } }>('/api/v1/snapshots/:id', async (request) => {
    const { id } = request.params;
    const raw = getOS(request).snapshots.loadRaw(id);
    if (!raw) {
      throw new NotFoundError(`快照 ${id} 不存在`, ErrorCode.NOT_FOUND_SNAPSHOT);
    }
    return { data: raw };
  });

  /* POST /api/v1/snapshots/:id/restore — 从快照恢复 */
  app.post<{ Params: { id: string } }>('/api/v1/snapshots/:id/restore', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);
    const ok = tenantOS.restoreFromSnapshot(id);
    if (!ok) {
      throw new NotFoundError(`快照 ${id} 不存在或恢复失败`, ErrorCode.NOT_FOUND_SNAPSHOT);
    }
    return { data: { restored: true, snapshotId: id } };
  });
}
