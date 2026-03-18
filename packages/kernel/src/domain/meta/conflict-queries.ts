/**
 * 冲突解决器 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const CONFLICT_QUERY_UNRESOLVED = 'conflict.unresolved' as const;
export const CONFLICT_QUERY_ALL = 'conflict.all' as const;

/* ── Command Kinds ── */

export const CONFLICT_CMD_RECORD = 'conflict.record' as const;
export const CONFLICT_CMD_RESOLVE = 'conflict.resolve' as const;
export const CONFLICT_CMD_DELETE_ALL = 'conflict.deleteAll' as const;
export const CONFLICT_CMD_RESTORE = 'conflict.restore' as const;

/* ── 行类型 ── */

export interface ConflictRow {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly involved_versions_json: string;
  readonly affected_values_json: string;
  readonly description: string;
  readonly detected_at: number;
  readonly resolved_at: number | null;
  readonly resolution: string | null;
}

/* ── 参数类型 ── */

export interface ConflictRecordParams {
  id: string;
  kind: string;
  severity: string;
  involvedVersionsJson: string;
  affectedValuesJson: string;
  description: string;
  detectedAt: number;
}

export interface ConflictResolveParams {
  id: string;
  resolvedAt: number;
  resolution: string;
}

export interface ConflictRestoreParams {
  id: string;
  kind: string;
  severity: string;
  involvedVersionsJson: string;
  affectedValuesJson: string;
  description: string;
  detectedAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

/* ── Query 工厂 ── */

export function conflictQueryUnresolved(): Query<ConflictRow, void> {
  return { kind: CONFLICT_QUERY_UNRESOLVED, params: undefined as unknown as void };
}

export function conflictQueryAll(): Query<ConflictRow, void> {
  return { kind: CONFLICT_QUERY_ALL, params: undefined as unknown as void };
}

/* ── Command 工厂 ── */

export function conflictCmdRecord(params: ConflictRecordParams): Command<ConflictRecordParams> {
  return { kind: CONFLICT_CMD_RECORD, params };
}

export function conflictCmdResolve(params: ConflictResolveParams): Command<ConflictResolveParams> {
  return { kind: CONFLICT_CMD_RESOLVE, params };
}

export function conflictCmdDeleteAll(): Command<void> {
  return { kind: CONFLICT_CMD_DELETE_ALL, params: undefined as unknown as void };
}

export function conflictCmdRestore(params: ConflictRestoreParams): Command<ConflictRestoreParams> {
  return { kind: CONFLICT_CMD_RESTORE, params };
}
