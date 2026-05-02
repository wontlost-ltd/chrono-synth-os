/**
 * 冲突收件箱路由
 */

import type { FastifyInstance } from 'fastify';
import type { ConflictInboxItemV1, ConflictResolveResultV1 } from '@chrono/contracts';
import type { AppConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import {
  countBlockingConflicts,
  createConflict,
  getConflict,
  listConflicts,
  resolveConflict,
  type ConflictInboxRow,
} from '../../privacy/conflict-inbox-store.js';
import {
  ConflictInboxItemV1Schema,
  ConflictResolveRequestV1Schema,
  ConflictResolveResultV1Schema,
} from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';
import { parsePagination, paginate } from '../plugins/pagination.js';

function parseJsonRecord(value: string): Record<string, string | number> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, string | number>;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function toInboxItem(row: ConflictInboxRow): ConflictInboxItemV1 {
  return ConflictInboxItemV1Schema.parse({
    schemaVersion: 'conflict-inbox.v1',
    conflictId: row.conflict_id,
    conflictVersion: row.conflict_version,
    tenantId: row.tenant_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    ...(row.command_id ? { commandId: row.command_id } : {}),
    sourceRuntime: row.source_runtime,
    detectedAt: row.detected_at,
    severity: row.severity,
    localSummaryId: row.local_summary_id,
    localSummaryParams: parseJsonRecord(row.local_summary_params),
    serverSummaryId: row.server_summary_id,
    serverSummaryParams: parseJsonRecord(row.server_summary_params),
    suggestedActions: parseStringArray(row.suggested_actions),
  });
}

function toRow(item: ConflictInboxItemV1): Omit<ConflictInboxRow, 'resolved_at' | 'resolution_action'> {
  return {
    conflict_id: item.conflictId,
    conflict_version: item.conflictVersion,
    tenant_id: item.tenantId,
    entity_type: item.entityType,
    entity_id: item.entityId,
    command_id: item.commandId ?? null,
    source_runtime: item.sourceRuntime,
    detected_at: item.detectedAt,
    severity: item.severity,
    local_summary_id: item.localSummaryId,
    local_summary_params: JSON.stringify(item.localSummaryParams),
    server_summary_id: item.serverSummaryId,
    server_summary_params: JSON.stringify(item.serverSummaryParams),
    suggested_actions: JSON.stringify(item.suggestedActions),
  };
}

export function registerConflictRoutes(
  app: FastifyInstance,
  db: IDatabase,
  _config?: AppConfig,
): void {
  /* GET /api/v1/conflicts — list unresolved conflicts for tenant */
  app.get('/api/v1/conflicts', { preHandler: requireRole('user') }, async (request) => {
    const params = parsePagination(request.query as Record<string, unknown>);
    const conflicts = listConflicts(db, request.tenantId, true).map(toInboxItem);
    return paginate(conflicts, params);
  });

  /* GET /api/v1/conflicts/:conflictId — get single conflict */
  app.get<{ Params: { conflictId: string } }>(
    '/api/v1/conflicts/:conflictId',
    { preHandler: requireRole('user') },
    async (request, reply) => {
      const row = getConflict(db, request.params.conflictId);
      if (!row || row.tenant_id !== request.tenantId) {
        return reply.code(404).send({ error: 'Conflict not found' });
      }
      return { data: toInboxItem(row) };
    },
  );

  /* POST /api/v1/conflicts/:conflictId/resolve — resolve conflict */
  app.post<{ Params: { conflictId: string } }>(
    '/api/v1/conflicts/:conflictId/resolve',
    { preHandler: requireRole('user') },
    async (request, reply) => {
      const body = ConflictResolveRequestV1Schema.parse(request.body);
      if (body.conflictId !== request.params.conflictId) {
        return reply.code(400).send({ error: 'conflictId mismatch' });
      }

      const row = getConflict(db, body.conflictId);
      if (!row || row.tenant_id !== request.tenantId) {
        return reply.code(404).send({ error: 'Conflict not found' });
      }
      if (row.conflict_version !== body.ifMatch) {
        return reply.code(409).send({ error: 'Conflict version mismatch' });
      }

      const resolvedAt = new Date().toISOString();
      const resolved = resolveConflict(db, body.conflictId, body.action, resolvedAt);
      if (!resolved) {
        return reply.code(404).send({ error: 'Conflict not found' });
      }

      const remainingBlockingCount = countBlockingConflicts(db, request.tenantId);
      const result: ConflictResolveResultV1 = ConflictResolveResultV1Schema.parse({
        schemaVersion: 'conflict-resolve-result.v1',
        conflictId: body.conflictId,
        action: body.action,
        resolvedAt,
        resultingSyncState: remainingBlockingCount > 0 ? 'conflict_inbox' : 'online_synced',
        remainingBlockingCount,
      });
      return { data: result };
    },
  );

  /* POST /api/v1/conflicts — internal conflict creation by sync pipeline */
  app.post('/api/v1/conflicts', { preHandler: requireRole('service', 'admin') }, async (request) => {
    const item = ConflictInboxItemV1Schema.parse(request.body);
    createConflict(db, toRow(item));
    return { data: item };
  });
}
