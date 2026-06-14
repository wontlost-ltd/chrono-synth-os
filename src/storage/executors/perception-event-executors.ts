/**
 * 感知事件审计 SQL 执行器（深化感知）。全部 tenant scoped（GDPR/隔离）。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { PerceptionEventRow, PerceptionEventInsertParams } from '@chrono/kernel';
import {
  PERCEPTION_EVENT_QUERY_BY_TENANT, PERCEPTION_EVENT_CMD_INSERT,
} from '@chrono/kernel';

export function registerPerceptionEventExecutors(): void {
  registerQuery<PerceptionEventRow[], string>(PERCEPTION_EVENT_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<PerceptionEventRow>(
      'SELECT * FROM perception_events WHERE tenant_id = ? ORDER BY created_at DESC',
    ).all(tenantId);
  });

  registerCommand<PerceptionEventInsertParams>(PERCEPTION_EVENT_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO perception_events
        (id, tenant_id, persona_id, modality, representation_sha256, provider_name, memory_count, candidate_count, pending_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.personaId, p.modality, p.representationSha256, p.providerName, p.memoryCount, p.candidateCount, p.pendingCount, p.status, p.createdAt);
    return { rowsAffected: result.changes };
  });
}
