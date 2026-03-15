/**
 * 审计日志端点
 * 查询系统操作审计记录
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { countAuditLogs, getAuditLogById, queryAuditLog } from '../../audit/audit-log-store.js';
import { PaginationQuerySchema } from '../schemas/api-schemas.js';

export function registerAuditRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  const listHandler = async (request: FastifyRequest) => {
    if (!db) return { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = PaginationQuerySchema.parse(query);
    const offset = (page - 1) * pageSize;
    const tenantId = request.tenantId ?? 'default';
    const eventKind = typeof query.eventKind === 'string' ? query.eventKind : 'all';
    const actorId = typeof query.actorId === 'string' ? query.actorId : undefined;
    const actionType = typeof query.actionType === 'string' ? query.actionType : undefined;
    const targetType = typeof query.targetType === 'string' ? query.targetType : undefined;
    const targetId = typeof query.targetId === 'string' ? query.targetId : undefined;

    const total = countAuditLogs(db, {
      tenantId,
      eventKind: eventKind === 'request' || eventKind === 'business' ? eventKind : 'all',
      actorId,
      actionType,
      targetType,
      targetId,
    });
    const rows = queryAuditLog(db, {
      tenantId,
      limit: pageSize,
      offset,
      eventKind: eventKind === 'request' || eventKind === 'business' ? eventKind : 'all',
      actorId,
      actionType,
      targetType,
      targetId,
    });
    return {
      data: rows,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
  };

  app.get('/api/v1/audit', listHandler);
  app.get('/api/v1/audit/logs', listHandler);

  app.get<{ Params: { id: string } }>('/api/v1/audit/logs/:id', async (request) => {
    if (!db) return { data: null };
    const record = getAuditLogById(db, request.tenantId ?? 'default', request.params.id);
    return { data: record };
  });
}
