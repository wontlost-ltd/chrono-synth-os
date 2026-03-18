/**
 * 人格引擎 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  PENG_QUERY_BY_ID, PENG_QUERY_ACTIVE, PENG_QUERY_ALL,
  PENG_CMD_CREATE, PENG_CMD_SET_STATUS, PENG_CMD_SET_RESULTS,
  PENG_CMD_SET_QUOTA, PENG_CMD_DELETE, PENG_CMD_DELETE_ALL,
  PENG_CMD_INSERT_RAW,
} from '@chrono/kernel';
import type {
  PengRow, PengCreateParams, PengSetStatusParams,
  PengSetResultsParams, PengSetQuotaParams, PengInsertRawParams,
} from '@chrono/kernel';

export function registerPersonaEngineExecutors(): void {
  registerQuery<PengRow | null, string>(PENG_QUERY_BY_ID, (db, id) => {
    return db.prepare<PengRow>(
      'SELECT * FROM persona_versions WHERE id = ?',
    ).get(id) ?? null;
  });

  registerQuery<readonly PengRow[], void>(PENG_QUERY_ACTIVE, (db) => {
    return db.prepare<PengRow>(
      "SELECT * FROM persona_versions WHERE status = 'active'",
    ).all();
  });

  registerQuery<readonly PengRow[], void>(PENG_QUERY_ALL, (db) => {
    return db.prepare<PengRow>(
      'SELECT * FROM persona_versions',
    ).all();
  });

  registerCommand<PengCreateParams>(PENG_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_versions (id, label, values_json, status, results_json, resource_quota, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '[]', ?, ?, ?)`,
    ).run(p.id, p.label, p.valuesJson, p.resourceQuota, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PengSetStatusParams>(PENG_CMD_SET_STATUS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE persona_versions SET status = ?, updated_at = ? WHERE id = ?',
    ).run(p.status, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<PengSetResultsParams>(PENG_CMD_SET_RESULTS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE persona_versions SET results_json = ?, updated_at = ? WHERE id = ?',
    ).run(p.resultsJson, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<PengSetQuotaParams>(PENG_CMD_SET_QUOTA, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE persona_versions SET resource_quota = ?, updated_at = ? WHERE id = ?',
    ).run(p.quota, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(PENG_CMD_DELETE, (db, id) => {
    const result = db.prepare<void>(
      'DELETE FROM persona_versions WHERE id = ?',
    ).run(id);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(PENG_CMD_DELETE_ALL, (db) => {
    const result = db.prepare<void>('DELETE FROM persona_versions WHERE 1=1').run();
    return { rowsAffected: result.changes };
  });

  registerCommand<PengInsertRawParams>(PENG_CMD_INSERT_RAW, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_versions (id, label, values_json, status, results_json, resource_quota, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, values_json=excluded.values_json, status=excluded.status, results_json=excluded.results_json, resource_quota=excluded.resource_quota, created_at=excluded.created_at, updated_at=excluded.updated_at`,
    ).run(p.id, p.label, p.valuesJson, p.status, p.resultsJson, p.resourceQuota, p.createdAt, p.updatedAt);
    return { rowsAffected: result.changes };
  });
}
