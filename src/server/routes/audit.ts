/**
 * 审计日志端点
 * 查询系统操作审计记录
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { queryAuditLog } from '../plugins/audit-log.js';
import { PaginationQuerySchema } from '../schemas/api-schemas.js';

export function registerAuditRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  app.get('/api/v1/audit', async (request) => {
    if (!db) return { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const offset = (page - 1) * pageSize;
    const tenantId = request.tenantId;

    const total = db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log WHERE tenant_id = ?',
    ).get(tenantId)?.count ?? 0;
    const rows = queryAuditLog(db, pageSize, tenantId, offset);
    return {
      data: rows,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
  });
}
