/**
 * 配置存储 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';
import type { ConfigCategory } from '../config-metadata.js';

/* ── Query Kinds ── */

export const CFG_QUERY_ALL = 'config.all' as const;
export const CFG_QUERY_BY_CATEGORY = 'config.byCategory' as const;
export const CFG_QUERY_BY_KEY = 'config.byKey' as const;
export const CFG_QUERY_AUDIT = 'config.audit' as const;
export const CFG_QUERY_AUDIT_BY_KEY = 'config.auditByKey' as const;

/* ── Command Kinds ── */

export const CFG_CMD_UPSERT = 'config.upsert' as const;
export const CFG_CMD_AUDIT_LOG = 'config.auditLog' as const;

/* ── 行类型 ── */

export interface ConfigItemRow {
  readonly key: string;
  readonly value_json: string;
  readonly category: ConfigCategory;
  readonly requires_restart: number;
  readonly group_key: string;
  readonly updated_at: number;
  readonly updated_by: string;
}

export interface ConfigAuditRow {
  readonly id: number;
  readonly config_key: string;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly changed_by: string;
  readonly changed_at: number;
}

/* ── 参数类型 ── */

export interface CfgUpsertParams {
  key: string;
  valueJson: string;
  category: ConfigCategory;
  requiresRestart: number;
  groupKey: string;
  now: number;
  changedBy: string;
}

export interface CfgAuditLogParams {
  configKey: string;
  oldValue: string | null;
  newValue: string;
  changedBy: string;
  now: number;
}

export interface CfgAuditParams {
  limit: number;
  offset: number;
}

export interface CfgAuditByKeyParams {
  key: string;
  limit: number;
}

/* ── Query 工厂 ── */

export function cfgQueryAll(): Query<ConfigItemRow, void> {
  return { kind: CFG_QUERY_ALL, params: undefined as unknown as void };
}

export function cfgQueryByCategory(category: ConfigCategory): Query<ConfigItemRow, ConfigCategory> {
  return { kind: CFG_QUERY_BY_CATEGORY, params: category };
}

export function cfgQueryByKey(key: string): Query<ConfigItemRow | null, string> {
  return { kind: CFG_QUERY_BY_KEY, params: key };
}

export function cfgQueryAudit(limit: number, offset: number): Query<ConfigAuditRow, CfgAuditParams> {
  return { kind: CFG_QUERY_AUDIT, params: { limit, offset } };
}

export function cfgQueryAuditByKey(key: string, limit: number): Query<ConfigAuditRow, CfgAuditByKeyParams> {
  return { kind: CFG_QUERY_AUDIT_BY_KEY, params: { key, limit } };
}

/* ── Command 工厂 ── */

export function cfgCmdUpsert(params: CfgUpsertParams): Command<CfgUpsertParams> {
  return { kind: CFG_CMD_UPSERT, params };
}

export function cfgCmdAuditLog(params: CfgAuditLogParams): Command<CfgAuditLogParams> {
  return { kind: CFG_CMD_AUDIT_LOG, params };
}
