import type { IDatabase } from '../storage/database.js';

export interface ConflictInboxRow {
  conflict_id: string;
  conflict_version: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  command_id: string | null;
  source_runtime: string;
  detected_at: string;
  severity: string;
  local_summary_id: string;
  local_summary_params: string;
  server_summary_id: string;
  server_summary_params: string;
  suggested_actions: string;
  resolved_at: string | null;
  resolution_action: string | null;
}

export function createConflict(
  db: IDatabase,
  item: Omit<ConflictInboxRow, 'resolved_at' | 'resolution_action'>,
): void {
  db.prepare<void>(
    `INSERT INTO conflict_inbox (
      conflict_id,
      conflict_version,
      tenant_id,
      entity_type,
      entity_id,
      command_id,
      source_runtime,
      detected_at,
      severity,
      local_summary_id,
      local_summary_params,
      server_summary_id,
      server_summary_params,
      suggested_actions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.conflict_id,
    item.conflict_version,
    item.tenant_id,
    item.entity_type,
    item.entity_id,
    item.command_id,
    item.source_runtime,
    item.detected_at,
    item.severity,
    item.local_summary_id,
    item.local_summary_params,
    item.server_summary_id,
    item.server_summary_params,
    item.suggested_actions,
  );
}

export function getConflict(db: IDatabase, conflictId: string): ConflictInboxRow | null {
  return db.prepare<ConflictInboxRow>(
    `SELECT
      conflict_id,
      conflict_version,
      tenant_id,
      entity_type,
      entity_id,
      command_id,
      source_runtime,
      detected_at,
      severity,
      local_summary_id,
      local_summary_params,
      server_summary_id,
      server_summary_params,
      suggested_actions,
      resolved_at,
      resolution_action
     FROM conflict_inbox
     WHERE conflict_id = ?`,
  ).get(conflictId) ?? null;
}

export function listConflicts(
  db: IDatabase,
  tenantId: string,
  onlyUnresolved = false,
): ConflictInboxRow[] {
  const where = onlyUnresolved
    ? 'WHERE tenant_id = ? AND resolved_at IS NULL'
    : 'WHERE tenant_id = ?';
  return db.prepare<ConflictInboxRow>(
    `SELECT
      conflict_id,
      conflict_version,
      tenant_id,
      entity_type,
      entity_id,
      command_id,
      source_runtime,
      detected_at,
      severity,
      local_summary_id,
      local_summary_params,
      server_summary_id,
      server_summary_params,
      suggested_actions,
      resolved_at,
      resolution_action
     FROM conflict_inbox
     ${where}
     ORDER BY detected_at DESC`,
  ).all(tenantId);
}

export function resolveConflict(
  db: IDatabase,
  conflictId: string,
  action: string,
  resolvedAt: string,
): boolean {
  const result = db.prepare<void>(
    `UPDATE conflict_inbox
     SET resolved_at = ?, resolution_action = ?
     WHERE conflict_id = ? AND resolved_at IS NULL`,
  ).run(resolvedAt, action, conflictId);
  return result.changes > 0;
}

export function countBlockingConflicts(db: IDatabase, tenantId: string): number {
  const row = db.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM conflict_inbox
     WHERE tenant_id = ? AND severity = 'blocking' AND resolved_at IS NULL`,
  ).get(tenantId);
  return row?.count ?? 0;
}
