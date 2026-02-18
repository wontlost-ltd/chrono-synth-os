/**
 * 审计日志端点
 * 查询系统操作审计记录
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { queryAuditLog } from '../plugins/audit-log.js';

export function registerAuditRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  app.get<{ Querystring: { limit?: string } }>('/api/v1/audit', async (request) => {
    if (!db) return { data: [] };
    const limit = Math.min(parseInt(request.query.limit || '100', 10) || 100, 1000);
    const tenantId = request.tenantId;
    return { data: queryAuditLog(db, limit, tenantId) };
  });
}
