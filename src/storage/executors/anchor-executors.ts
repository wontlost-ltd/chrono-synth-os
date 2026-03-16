/**
 * 生存锚点 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import type { IDatabase } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  ANCHOR_QUERY_BY_ID, ANCHOR_QUERY_ALL,
  ANCHOR_CMD_CREATE, ANCHOR_CMD_UPDATE, ANCHOR_CMD_DELETE,
  ANCHOR_CMD_DELETE_ALL, ANCHOR_CMD_UPSERT,
} from '@chrono/kernel';
import type { SurvivalAnchor, CreateAnchorParams, UpdateAnchorParams } from '@chrono/kernel';

interface AnchorRow {
  id: string;
  label: string;
  kind: string;
  value_json: string;
  severity: number;
  created_at: number;
  updated_at: number;
}

function toAnchor(row: AnchorRow): SurvivalAnchor {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as SurvivalAnchor['kind'],
    value: JSON.parse(row.value_json),
    severity: row.severity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerAnchorExecutors(): void {
  registerQuery<SurvivalAnchor | null, { id: string }>(ANCHOR_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<AnchorRow>(
      'SELECT * FROM survival_anchors WHERE id = ?',
    ).get(params.id);
    return row ? toAnchor(row) : null;
  });

  registerQuery<SurvivalAnchor[], void>(ANCHOR_QUERY_ALL, (db: IDatabase) => {
    const rows = db.prepare<AnchorRow>(
      'SELECT * FROM survival_anchors ORDER BY created_at',
    ).all();
    return rows.map(toAnchor);
  });

  registerCommand<CreateAnchorParams>(ANCHOR_CMD_CREATE, (db, p) => {
    db.prepare<void>(
      'INSERT INTO survival_anchors (id, label, kind, value_json, severity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(p.id, p.label, p.kind, p.valueJson, p.severity, p.createdAt, p.updatedAt);
    return { rowsAffected: 1 };
  });

  registerCommand<UpdateAnchorParams>(ANCHOR_CMD_UPDATE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE survival_anchors SET label = ?, kind = ?, value_json = ?, severity = ?, updated_at = ? WHERE id = ?',
    ).run(p.label, p.kind, p.valueJson, p.severity, p.updatedAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<{ id: string }>(ANCHOR_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>('DELETE FROM survival_anchors WHERE id = ?').run(p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(ANCHOR_CMD_DELETE_ALL, (db: IDatabase) => {
    db.prepare<void>('DELETE FROM survival_anchors WHERE 1=1').run();
    return { rowsAffected: 0 };
  });

  registerCommand<CreateAnchorParams>(ANCHOR_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO survival_anchors (id, label, kind, value_json, severity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, kind=excluded.kind, value_json=excluded.value_json, severity=excluded.severity, created_at=excluded.created_at, updated_at=excluded.updated_at`,
    ).run(p.id, p.label, p.kind, p.valueJson, p.severity, p.createdAt, p.updatedAt);
    return { rowsAffected: 1 };
  });
}
