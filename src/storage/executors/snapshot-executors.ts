/**
 * 快照/演化 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { SnapshotRow, SnapshotSummaryRow, SnapSaveParams, EvoPersistParams } from '@chrono/kernel';
import {
  SNAP_QUERY_BY_ID, SNAP_QUERY_LATEST, SNAP_QUERY_LIST,
  SNAP_CMD_SAVE, SNAP_CMD_DELETE, EVO_CMD_PERSIST,
} from '@chrono/kernel';

export function registerSnapshotExecutors(): void {
  /* ── Queries ── */

  registerQuery<SnapshotRow | null, string>(SNAP_QUERY_BY_ID, (db, id) => {
    return db.prepare<SnapshotRow>(
      'SELECT * FROM snapshots WHERE id = ?',
    ).get(id) ?? null;
  });

  registerQuery<SnapshotRow | null, void>(SNAP_QUERY_LATEST, (db) => {
    return db.prepare<SnapshotRow>(
      'SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1',
    ).get() ?? null;
  });

  registerQuery<SnapshotSummaryRow[], void>(SNAP_QUERY_LIST, (db) => {
    return db.prepare<SnapshotSummaryRow>(
      'SELECT id, reason, created_at FROM snapshots ORDER BY created_at DESC',
    ).all();
  });

  /* ── Commands ── */

  registerCommand<SnapSaveParams>(SNAP_CMD_SAVE, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run(p.id, p.dataJson, p.reason, p.createdAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SNAP_CMD_DELETE, (db, id) => {
    const result = db.prepare<void>(
      'DELETE FROM snapshots WHERE id = ?',
    ).run(id);
    return { rowsAffected: result.changes };
  });

  registerCommand<EvoPersistParams>(EVO_CMD_PERSIST, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO evolution_records (id, before_snapshot_id, after_snapshot_id, merged_version_ids_json, value_delta_json, evolved_at, diff_report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.beforeSnapshotId, p.afterSnapshotId, p.mergedVersionIdsJson, p.valueDeltaJson, p.evolvedAt, p.diffReportJson);
    return { rowsAffected: result.changes };
  });
}
