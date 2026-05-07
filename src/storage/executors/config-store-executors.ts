/**
 * 配置存储 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  ConfigItemRow, ConfigAuditRow, ConfigCategory,
  CfgUpsertParams, CfgAuditLogParams, CfgAuditParams, CfgAuditByKeyParams,
} from '@chrono/kernel';
import {
  CFG_QUERY_ALL, CFG_QUERY_BY_CATEGORY, CFG_QUERY_BY_KEY,
  CFG_QUERY_AUDIT, CFG_QUERY_AUDIT_BY_KEY,
  CFG_CMD_UPSERT, CFG_CMD_AUDIT_LOG,
} from '@chrono/kernel';

export function registerConfigStoreExecutors(): void {
  /* ── Queries ── */

  registerQuery<ConfigItemRow[], void>(CFG_QUERY_ALL, (db) => {
    return db.prepare<ConfigItemRow>(
      'SELECT * FROM config_items ORDER BY key',
    ).all();
  });

  registerQuery<ConfigItemRow[], ConfigCategory>(CFG_QUERY_BY_CATEGORY, (db, category) => {
    return db.prepare<ConfigItemRow>(
      'SELECT * FROM config_items WHERE category = ? ORDER BY key',
    ).all(category);
  });

  registerQuery<ConfigItemRow | null, string>(CFG_QUERY_BY_KEY, (db, key) => {
    return db.prepare<ConfigItemRow>(
      'SELECT * FROM config_items WHERE key = ?',
    ).get(key) ?? null;
  });

  registerQuery<ConfigAuditRow[], CfgAuditParams>(CFG_QUERY_AUDIT, (db, p) => {
    return db.prepare<ConfigAuditRow>(
      'SELECT * FROM config_audit ORDER BY changed_at DESC LIMIT ? OFFSET ?',
    ).all(p.limit, p.offset);
  });

  registerQuery<ConfigAuditRow[], CfgAuditByKeyParams>(CFG_QUERY_AUDIT_BY_KEY, (db, p) => {
    return db.prepare<ConfigAuditRow>(
      'SELECT * FROM config_audit WHERE config_key = ? ORDER BY changed_at DESC LIMIT ?',
    ).all(p.key, p.limit);
  });

  /* ── Commands ── */

  registerCommand<CfgUpsertParams>(CFG_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO config_items (key, value_json, category, requires_restart, group_key, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).run(p.key, p.valueJson, p.category, p.requiresRestart, p.groupKey, p.now, p.changedBy);
    return { rowsAffected: result.changes };
  });

  registerCommand<CfgAuditLogParams>(CFG_CMD_AUDIT_LOG, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO config_audit (config_key, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(p.configKey, p.oldValue, p.newValue, p.changedBy, p.now);
    return { rowsAffected: result.changes };
  });
}
