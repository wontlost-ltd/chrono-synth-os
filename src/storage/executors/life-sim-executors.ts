/**
 * 人生模拟存储 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  LifeSimRow, LifeSimPathRow,
  LsimCreateParams, LsimSetStatusParams, LsimSetStatusCompletedParams,
  LsimUpdateProgressParams, LsimSaveSummaryParams, LsimSavePathParams,
  LsimByIdTenantParams, LsimByTenantParams, LsimPaginatedParams,
  LsimPathDetailParams, LsimPathDetailTenantParams,
  LsimVariantsParams, LsimVariantsTenantParams,
} from '@chrono/kernel';
import {
  LSIM_QUERY_BY_ID, LSIM_QUERY_BY_ID_TENANT, LSIM_QUERY_BY_TENANT,
  LSIM_QUERY_COUNT_BY_TENANT, LSIM_QUERY_PAGINATED,
  LSIM_QUERY_PATH_DETAIL, LSIM_QUERY_PATH_DETAIL_TENANT,
  LSIM_QUERY_VARIANTS, LSIM_QUERY_VARIANTS_TENANT, LSIM_QUERY_PATHS_BY_SIM,
  LSIM_CMD_CREATE, LSIM_CMD_SET_STATUS, LSIM_CMD_SET_STATUS_COMPLETED,
  LSIM_CMD_UPDATE_PROGRESS, LSIM_CMD_SAVE_SUMMARY, LSIM_CMD_SAVE_PATH,
} from '@chrono/kernel';

export function registerLifeSimExecutors(): void {
  /* ── Queries ── */

  registerQuery<LifeSimRow | null, string>(LSIM_QUERY_BY_ID, (db, id) => {
    return db.prepare<LifeSimRow>(
      'SELECT * FROM life_simulations WHERE id = ?',
    ).get(id) ?? null;
  });

  registerQuery<LifeSimRow | null, LsimByIdTenantParams>(LSIM_QUERY_BY_ID_TENANT, (db, p) => {
    return db.prepare<LifeSimRow>(
      'SELECT * FROM life_simulations WHERE id = ? AND tenant_id = ?',
    ).get(p.id, p.tenantId) ?? null;
  });

  registerQuery<LifeSimRow[], LsimByTenantParams>(LSIM_QUERY_BY_TENANT, (db, p) => {
    return db.prepare<LifeSimRow>(
      'SELECT * FROM life_simulations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(p.tenantId, p.limit);
  });

  registerQuery<{ count: number } | null, string>(LSIM_QUERY_COUNT_BY_TENANT, (db, tenantId) => {
    return db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM life_simulations WHERE tenant_id = ?',
    ).get(tenantId) ?? null;
  });

  registerQuery<LifeSimRow[], LsimPaginatedParams>(LSIM_QUERY_PAGINATED, (db, p) => {
    return db.prepare<LifeSimRow>(
      'SELECT * FROM life_simulations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(p.tenantId, p.limit, p.offset);
  });

  registerQuery<LifeSimPathRow | null, LsimPathDetailParams>(LSIM_QUERY_PATH_DETAIL, (db, p) => {
    return db.prepare<LifeSimPathRow>(
      'SELECT * FROM life_simulation_paths WHERE simulation_id = ? AND path_id = ?',
    ).get(p.simulationId, p.pathId) ?? null;
  });

  registerQuery<LifeSimPathRow | null, LsimPathDetailTenantParams>(LSIM_QUERY_PATH_DETAIL_TENANT, (db, p) => {
    return db.prepare<LifeSimPathRow>(
      `SELECT p.* FROM life_simulation_paths p
       JOIN life_simulations s ON s.id = p.simulation_id
       WHERE p.simulation_id = ? AND p.path_id = ? AND s.tenant_id = ?`,
    ).get(p.simulationId, p.pathId, p.tenantId) ?? null;
  });

  registerQuery<LifeSimRow[], LsimVariantsParams>(LSIM_QUERY_VARIANTS, (db, p) => {
    return db.prepare<LifeSimRow>(
      'SELECT * FROM life_simulations WHERE base_simulation_id = ? ORDER BY created_at ASC',
    ).all(p.baseSimulationId);
  });

  registerQuery<LifeSimRow[], LsimVariantsTenantParams>(LSIM_QUERY_VARIANTS_TENANT, (db, p) => {
    return db.prepare<LifeSimRow>(
      'SELECT * FROM life_simulations WHERE base_simulation_id = ? AND tenant_id = ? ORDER BY created_at ASC',
    ).all(p.baseSimulationId, p.tenantId);
  });

  registerQuery<LifeSimPathRow[], string>(LSIM_QUERY_PATHS_BY_SIM, (db, simId) => {
    return db.prepare<LifeSimPathRow>(
      'SELECT * FROM life_simulation_paths WHERE simulation_id = ? ORDER BY created_at ASC',
    ).all(simId);
  });

  /* ── Commands ── */

  registerCommand<LsimCreateParams>(LSIM_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO life_simulations (id, tenant_id, task_id, base_simulation_id, config_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(p.id, p.tenantId, p.taskId, p.baseSimulationId, p.configJson, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<LsimSetStatusParams>(LSIM_CMD_SET_STATUS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE life_simulations SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    ).run(p.status, p.error, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<LsimSetStatusCompletedParams>(LSIM_CMD_SET_STATUS_COMPLETED, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE life_simulations SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?',
    ).run(p.status, p.error, p.now, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<LsimUpdateProgressParams>(LSIM_CMD_UPDATE_PROGRESS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE life_simulations SET progress_json = ?, updated_at = ? WHERE id = ?',
    ).run(p.progressJson, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<LsimSaveSummaryParams>(LSIM_CMD_SAVE_SUMMARY, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE life_simulations SET summary_json = ?, updated_at = ? WHERE id = ?',
    ).run(p.summaryJson, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<LsimSavePathParams>(LSIM_CMD_SAVE_PATH, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO life_simulation_paths (id, simulation_id, path_id, label, status, summary_json, timeline_json, branches_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'completed', summary_json = excluded.summary_json,
         timeline_json = excluded.timeline_json, branches_json = excluded.branches_json,
         updated_at = excluded.updated_at`,
    ).run(p.id, p.simulationId, p.pathId, p.label, p.summaryJson, p.timelineJson, p.branchesJson, p.now, p.now);
    return { rowsAffected: result.changes };
  });
}
