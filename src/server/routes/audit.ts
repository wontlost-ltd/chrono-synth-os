/**
 * 审计日志端点
 * 查询系统操作审计记录
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { queryAuditLog } from '../plugins/audit-log.js';

export function registerAuditRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  app.get('/api/v1/audit', async (request) => {
    if (!db) return { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
    const { page, pageSize } = request.query as { page?: string; pageSize?: string };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    const ps = Math.min(100, Math.max(1, parseInt(pageSize || '20', 10) || 20));
    const offset = (p - 1) * ps;
    const tenantId = request.tenantId;

    const total = db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log WHERE tenant_id = ?',
    ).get(tenantId)?.count ?? 0;
    const rows = queryAuditLog(db, ps, tenantId, offset);
    return {
      data: rows,
      pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) || 1 },
    };
  });
}
