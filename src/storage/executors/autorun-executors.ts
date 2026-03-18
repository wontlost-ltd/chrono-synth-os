/**
 * Avatar 自动运行 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  AutorunConfigRow, AutorunRunLogRow,
  AutorunConfigLookupParams, AutorunDueConfigsParams,
  AutorunUpdateConfigParams, AutorunInsertConfigParams,
  AutorunClaimConfigParams, AutorunUpdateDriftCheckParams,
  AutorunUpdateLastErrorParams, AutorunInsertRunParams,
  AutorunSetRunStartedParams, AutorunSetRunCompletedParams,
  AutorunSetRunStatusParams, AutorunUpdateRunTaskIdParams,
  AutorunRunsByAvatarParams,
} from '@chrono/kernel';
import {
  AUTORUN_QUERY_CONFIG, AUTORUN_QUERY_CONFIG_BY_ID, AUTORUN_QUERY_DUE_CONFIGS,
  AUTORUN_QUERY_RUN_BY_ID, AUTORUN_QUERY_RUNS_BY_AVATAR, AUTORUN_QUERY_RUNS_COUNT,
  AUTORUN_CMD_UPDATE_CONFIG, AUTORUN_CMD_INSERT_CONFIG, AUTORUN_CMD_CLAIM_CONFIG,
  AUTORUN_CMD_UPDATE_DRIFT_CHECK, AUTORUN_CMD_UPDATE_LAST_ERROR,
  AUTORUN_CMD_INSERT_RUN, AUTORUN_CMD_SET_RUN_STARTED, AUTORUN_CMD_SET_RUN_COMPLETED,
  AUTORUN_CMD_SET_RUN_STATUS, AUTORUN_CMD_UPDATE_RUN_TASK_ID,
} from '@chrono/kernel';

export function registerAutorunExecutors(): void {
  /* ── Queries ── */

  registerQuery<AutorunConfigRow | null, AutorunConfigLookupParams>(AUTORUN_QUERY_CONFIG, (db, p) => {
    return db.prepare<AutorunConfigRow>(
      'SELECT * FROM avatar_autorun_config WHERE tenant_id = ? AND avatar_id = ?',
    ).get(p.tenantId, p.avatarId) ?? null;
  });

  registerQuery<AutorunConfigRow | null, string>(AUTORUN_QUERY_CONFIG_BY_ID, (db, id) => {
    return db.prepare<AutorunConfigRow>(
      'SELECT * FROM avatar_autorun_config WHERE id = ?',
    ).get(id) ?? null;
  });

  registerQuery<readonly AutorunConfigRow[], AutorunDueConfigsParams>(AUTORUN_QUERY_DUE_CONFIGS, (db, p) => {
    return db.prepare<AutorunConfigRow>(
      'SELECT * FROM avatar_autorun_config WHERE enabled = 1 AND next_run_at <= ? LIMIT ?',
    ).all(p.now, p.limit);
  });

  registerQuery<AutorunRunLogRow | null, string>(AUTORUN_QUERY_RUN_BY_ID, (db, id) => {
    return db.prepare<AutorunRunLogRow>(
      'SELECT * FROM avatar_autorun_runlog WHERE id = ?',
    ).get(id) ?? null;
  });

  registerQuery<readonly AutorunRunLogRow[], AutorunRunsByAvatarParams>(AUTORUN_QUERY_RUNS_BY_AVATAR, (db, p) => {
    return db.prepare<AutorunRunLogRow>(
      'SELECT * FROM avatar_autorun_runlog WHERE tenant_id = ? AND avatar_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(p.tenantId, p.avatarId, p.limit, p.offset);
  });

  registerQuery<{ count: number } | null, AutorunConfigLookupParams>(AUTORUN_QUERY_RUNS_COUNT, (db, p) => {
    return db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM avatar_autorun_runlog WHERE tenant_id = ? AND avatar_id = ?',
    ).get(p.tenantId, p.avatarId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<AutorunUpdateConfigParams>(AUTORUN_CMD_UPDATE_CONFIG, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE avatar_autorun_config
       SET enabled = ?, interval_ms = ?, drift_threshold = ?, drift_check_interval_ms = ?,
           review_required = ?, knowledge_source_ids_json = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(p.enabled, p.intervalMs, p.driftThreshold, p.driftCheckIntervalMs,
      p.reviewRequired, p.knowledgeSourceIdsJson, p.nextRunAt, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunInsertConfigParams>(AUTORUN_CMD_INSERT_CONFIG, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO avatar_autorun_config
       (id, tenant_id, avatar_id, enabled, interval_ms, next_run_at, knowledge_source_ids_json,
        drift_check_interval_ms, drift_threshold, review_required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.avatarId, p.enabled, p.intervalMs, p.nextRunAt,
      p.knowledgeSourceIdsJson, p.driftCheckIntervalMs, p.driftThreshold, p.reviewRequired, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunClaimConfigParams>(AUTORUN_CMD_CLAIM_CONFIG, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE avatar_autorun_config
       SET next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE id = ? AND next_run_at <= ?`,
    ).run(p.nextRunAt, p.now, p.now, p.id, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunUpdateDriftCheckParams>(AUTORUN_CMD_UPDATE_DRIFT_CHECK, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatar_autorun_config SET last_drift_check_at = ?, updated_at = ? WHERE id = ?',
    ).run(p.now, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunUpdateLastErrorParams>(AUTORUN_CMD_UPDATE_LAST_ERROR, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatar_autorun_config SET last_error = ?, updated_at = ? WHERE id = ?',
    ).run(p.error, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunInsertRunParams>(AUTORUN_CMD_INSERT_RUN, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO avatar_autorun_runlog
       (id, tenant_id, avatar_id, config_id, task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.avatarId, p.configId, p.taskId, p.status, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunSetRunStartedParams>(AUTORUN_CMD_SET_RUN_STARTED, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatar_autorun_runlog SET status = ?, started_at = ? WHERE id = ?',
    ).run(p.status, p.startedAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunSetRunCompletedParams>(AUTORUN_CMD_SET_RUN_COMPLETED, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatar_autorun_runlog SET status = ?, metrics_json = ?, error = ?, completed_at = ? WHERE id = ?',
    ).run(p.status, p.metricsJson, p.error, p.completedAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunSetRunStatusParams>(AUTORUN_CMD_SET_RUN_STATUS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatar_autorun_runlog SET status = ? WHERE id = ?',
    ).run(p.status, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<AutorunUpdateRunTaskIdParams>(AUTORUN_CMD_UPDATE_RUN_TASK_ID, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatar_autorun_runlog SET task_id = ? WHERE id = ?',
    ).run(p.taskId, p.id);
    return { rowsAffected: result.changes };
  });
}
