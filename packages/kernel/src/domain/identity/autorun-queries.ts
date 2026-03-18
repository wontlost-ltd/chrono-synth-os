/**
 * Avatar 自动运行 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const AUTORUN_QUERY_CONFIG = 'autorun.config-by-tenant-avatar' as const;
export const AUTORUN_QUERY_CONFIG_BY_ID = 'autorun.config-by-id' as const;
export const AUTORUN_QUERY_DUE_CONFIGS = 'autorun.due-configs' as const;
export const AUTORUN_QUERY_RUN_BY_ID = 'autorun.run-by-id' as const;
export const AUTORUN_QUERY_RUNS_BY_AVATAR = 'autorun.runs-by-avatar' as const;
export const AUTORUN_QUERY_RUNS_COUNT = 'autorun.runs-count' as const;

/* ── Command Kinds ── */

export const AUTORUN_CMD_UPDATE_CONFIG = 'autorun.update-config' as const;
export const AUTORUN_CMD_INSERT_CONFIG = 'autorun.insert-config' as const;
export const AUTORUN_CMD_CLAIM_CONFIG = 'autorun.claim-config' as const;
export const AUTORUN_CMD_UPDATE_DRIFT_CHECK = 'autorun.update-drift-check' as const;
export const AUTORUN_CMD_UPDATE_LAST_ERROR = 'autorun.update-last-error' as const;
export const AUTORUN_CMD_INSERT_RUN = 'autorun.insert-run' as const;
export const AUTORUN_CMD_SET_RUN_STARTED = 'autorun.set-run-started' as const;
export const AUTORUN_CMD_SET_RUN_COMPLETED = 'autorun.set-run-completed' as const;
export const AUTORUN_CMD_SET_RUN_STATUS = 'autorun.set-run-status' as const;
export const AUTORUN_CMD_UPDATE_RUN_TASK_ID = 'autorun.update-run-task-id' as const;

/* ── 行类型 ── */

export interface AutorunConfigRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly avatar_id: string;
  readonly enabled: number;
  readonly interval_ms: number;
  readonly next_run_at: number;
  readonly knowledge_source_ids_json: string;
  readonly drift_check_interval_ms: number;
  readonly drift_threshold: number;
  readonly review_required: number;
  readonly last_run_at: number | null;
  readonly last_drift_check_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AutorunRunLogRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly avatar_id: string;
  readonly config_id: string;
  readonly task_id: string;
  readonly status: string;
  readonly metrics_json: string | null;
  readonly error: string | null;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface AutorunConfigLookupParams {
  tenantId: string;
  avatarId: string;
}

export interface AutorunDueConfigsParams {
  now: number;
  limit: number;
}

export interface AutorunUpdateConfigParams {
  id: string;
  enabled: number;
  intervalMs: number;
  driftThreshold: number;
  driftCheckIntervalMs: number;
  reviewRequired: number;
  knowledgeSourceIdsJson: string;
  nextRunAt: number;
  now: number;
}

export interface AutorunInsertConfigParams {
  id: string;
  tenantId: string;
  avatarId: string;
  enabled: number;
  intervalMs: number;
  nextRunAt: number;
  knowledgeSourceIdsJson: string;
  driftCheckIntervalMs: number;
  driftThreshold: number;
  reviewRequired: number;
  now: number;
}

export interface AutorunClaimConfigParams {
  id: string;
  now: number;
  nextRunAt: number;
}

export interface AutorunUpdateDriftCheckParams {
  id: string;
  now: number;
}

export interface AutorunUpdateLastErrorParams {
  id: string;
  error: string | null;
  now: number;
}

export interface AutorunInsertRunParams {
  id: string;
  tenantId: string;
  avatarId: string;
  configId: string;
  taskId: string;
  status: string;
  now: number;
}

export interface AutorunSetRunStartedParams {
  id: string;
  status: string;
  startedAt: number;
}

export interface AutorunSetRunCompletedParams {
  id: string;
  status: string;
  metricsJson: string | null;
  error: string | null;
  completedAt: number;
}

export interface AutorunSetRunStatusParams {
  id: string;
  status: string;
}

export interface AutorunUpdateRunTaskIdParams {
  id: string;
  taskId: string;
}

export interface AutorunRunsByAvatarParams {
  tenantId: string;
  avatarId: string;
  limit: number;
  offset: number;
}

/* ── Query 工厂 ── */

export function autorunQueryConfig(tenantId: string, avatarId: string): Query<AutorunConfigRow | null, AutorunConfigLookupParams> {
  return { kind: AUTORUN_QUERY_CONFIG, params: { tenantId, avatarId } };
}

export function autorunQueryConfigById(id: string): Query<AutorunConfigRow | null, string> {
  return { kind: AUTORUN_QUERY_CONFIG_BY_ID, params: id };
}

export function autorunQueryDueConfigs(now: number, limit: number): Query<AutorunConfigRow, AutorunDueConfigsParams> {
  return { kind: AUTORUN_QUERY_DUE_CONFIGS, params: { now, limit } };
}

export function autorunQueryRunById(id: string): Query<AutorunRunLogRow | null, string> {
  return { kind: AUTORUN_QUERY_RUN_BY_ID, params: id };
}

export function autorunQueryRunsByAvatar(params: AutorunRunsByAvatarParams): Query<AutorunRunLogRow, AutorunRunsByAvatarParams> {
  return { kind: AUTORUN_QUERY_RUNS_BY_AVATAR, params };
}

export function autorunQueryRunsCount(tenantId: string, avatarId: string): Query<{ count: number } | null, AutorunConfigLookupParams> {
  return { kind: AUTORUN_QUERY_RUNS_COUNT, params: { tenantId, avatarId } };
}

/* ── Command 工厂 ── */

export function autorunCmdUpdateConfig(params: AutorunUpdateConfigParams): Command<AutorunUpdateConfigParams> {
  return { kind: AUTORUN_CMD_UPDATE_CONFIG, params };
}

export function autorunCmdInsertConfig(params: AutorunInsertConfigParams): Command<AutorunInsertConfigParams> {
  return { kind: AUTORUN_CMD_INSERT_CONFIG, params };
}

export function autorunCmdClaimConfig(params: AutorunClaimConfigParams): Command<AutorunClaimConfigParams> {
  return { kind: AUTORUN_CMD_CLAIM_CONFIG, params };
}

export function autorunCmdUpdateDriftCheck(params: AutorunUpdateDriftCheckParams): Command<AutorunUpdateDriftCheckParams> {
  return { kind: AUTORUN_CMD_UPDATE_DRIFT_CHECK, params };
}

export function autorunCmdUpdateLastError(params: AutorunUpdateLastErrorParams): Command<AutorunUpdateLastErrorParams> {
  return { kind: AUTORUN_CMD_UPDATE_LAST_ERROR, params };
}

export function autorunCmdInsertRun(params: AutorunInsertRunParams): Command<AutorunInsertRunParams> {
  return { kind: AUTORUN_CMD_INSERT_RUN, params };
}

export function autorunCmdSetRunStarted(params: AutorunSetRunStartedParams): Command<AutorunSetRunStartedParams> {
  return { kind: AUTORUN_CMD_SET_RUN_STARTED, params };
}

export function autorunCmdSetRunCompleted(params: AutorunSetRunCompletedParams): Command<AutorunSetRunCompletedParams> {
  return { kind: AUTORUN_CMD_SET_RUN_COMPLETED, params };
}

export function autorunCmdSetRunStatus(params: AutorunSetRunStatusParams): Command<AutorunSetRunStatusParams> {
  return { kind: AUTORUN_CMD_SET_RUN_STATUS, params };
}

export function autorunCmdUpdateRunTaskId(params: AutorunUpdateRunTaskIdParams): Command<AutorunUpdateRunTaskIdParams> {
  return { kind: AUTORUN_CMD_UPDATE_RUN_TASK_ID, params };
}
