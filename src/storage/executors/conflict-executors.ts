/**
 * 冲突解决器 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  ConflictRow, ConflictRecordParams, ConflictResolveParams, ConflictRestoreParams,
} from '@chrono/kernel';
import {
  CONFLICT_QUERY_UNRESOLVED, CONFLICT_QUERY_ALL,
  CONFLICT_CMD_RECORD, CONFLICT_CMD_RESOLVE, CONFLICT_CMD_DELETE_ALL, CONFLICT_CMD_RESTORE,
} from '@chrono/kernel';

export function registerConflictExecutors(): void {
  /* ── Queries ── */

  registerQuery<ConflictRow, void>(CONFLICT_QUERY_UNRESOLVED, (db) => {
    return db.prepare<ConflictRow>(
      'SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY detected_at DESC',
    ).all() as unknown as ConflictRow;
  });

  registerQuery<ConflictRow, void>(CONFLICT_QUERY_ALL, (db) => {
    return db.prepare<ConflictRow>(
      'SELECT * FROM conflicts ORDER BY detected_at DESC',
    ).all() as unknown as ConflictRow;
  });

  /* ── Commands ── */

  registerCommand<ConflictRecordParams>(CONFLICT_CMD_RECORD, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO conflicts (id, kind, severity, involved_versions_json, affected_values_json, description, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.kind, p.severity, p.involvedVersionsJson, p.affectedValuesJson, p.description, p.detectedAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<ConflictResolveParams>(CONFLICT_CMD_RESOLVE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL',
    ).run(p.resolvedAt, p.resolution, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(CONFLICT_CMD_DELETE_ALL, (db) => {
    const result = db.prepare<void>('DELETE FROM conflicts WHERE 1=1').run();
    return { rowsAffected: result.changes };
  });

  registerCommand<ConflictRestoreParams>(CONFLICT_CMD_RESTORE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO conflicts (id, kind, severity, involved_versions_json, affected_values_json, description, detected_at, resolved_at, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, severity=excluded.severity, involved_versions_json=excluded.involved_versions_json, affected_values_json=excluded.affected_values_json, description=excluded.description, detected_at=excluded.detected_at, resolved_at=excluded.resolved_at, resolution=excluded.resolution`,
    ).run(p.id, p.kind, p.severity, p.involvedVersionsJson, p.affectedValuesJson, p.description, p.detectedAt, p.resolvedAt, p.resolution);
    return { rowsAffected: result.changes };
  });
}
