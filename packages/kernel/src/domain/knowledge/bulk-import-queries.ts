/**
 * 批量知识导入 job Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

export type BulkImportJobState = 'queued' | 'running' | 'completed' | 'failed';
export type BulkImportDeduplicateStrategy = 'skip' | 'overwrite';
export type BulkImportCounterField = 'imported_count' | 'skipped_count' | 'failed_count';

/* ── Query Kinds ── */

export const BIMP_QUERY_BY_ID = 'bulkImport.byId' as const;
export const BIMP_QUERY_BY_TENANT_AND_ID = 'bulkImport.byTenantAndId' as const;
export const BIMP_QUERY_LIST_BY_PERSONA = 'bulkImport.listByPersona' as const;
export const BIMP_QUERY_FAILURES = 'bulkImport.failures' as const;
export const BIMP_QUERY_STUCK = 'bulkImport.stuck' as const;

/* ── Command Kinds ── */

export const BIMP_CMD_CREATE = 'bulkImport.create' as const;
export const BIMP_CMD_MARK_RUNNING = 'bulkImport.markRunning' as const;
export const BIMP_CMD_INCREMENT_COUNTER = 'bulkImport.incrementCounter' as const;
export const BIMP_CMD_UPDATE_FAILURES = 'bulkImport.updateFailures' as const;
export const BIMP_CMD_SET_METADATA = 'bulkImport.setMetadata' as const;
export const BIMP_CMD_MARK_COMPLETED = 'bulkImport.markCompleted' as const;
export const BIMP_CMD_MARK_FAILED = 'bulkImport.markFailed' as const;
export const BIMP_QUERY_FIND_BY_FINGERPRINT = 'bulkImport.findByFingerprint' as const;
export const BIMP_CMD_DELETE_BY_FINGERPRINT = 'bulkImport.deleteByFingerprint' as const;

/* ── 行类型 ── */

export interface BimpJobRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly owner_user_id: string;
  readonly state: BulkImportJobState;
  readonly total_items: number;
  readonly imported_count: number;
  readonly skipped_count: number;
  readonly failed_count: number;
  readonly failures_json: string;
  readonly deduplicate_strategy: BulkImportDeduplicateStrategy;
  readonly metadata_json: string | null;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly completed_at: number | null;
}

export interface BimpFailuresRow {
  readonly failures_json: string;
  readonly failed_count: number;
}

export interface BimpStuckRow {
  readonly id: string;
}

/* ── 参数类型 ── */

export interface BimpByIdParams {
  jobId: string;
}

export interface BimpByTenantAndIdParams {
  jobId: string;
  tenantId: string;
}

export interface BimpListByPersonaParams {
  tenantId: string;
  personaId: string;
  limit: number;
}

export interface BimpStuckParams {
  /**
   * 判定「卡死」的**时长**（毫秒），不是截止时刻（issue #395）。
   *
   * ⚠️ `started_at` 由跑 import 的副本写、回收判定跑在 worker 副本上，
   * 两端时钟不同源时钟差直接平移判定——worker 钟快就会把**正在跑**的
   * import job 标成 failed。
   *
   * 该回收路径当前**无生产调用方**（属潜伏），但接线时缺陷就会生效，
   * 故一并按同一形状修好，免得日后接线的人踩同一个坑。
   *
   * ⚠️ 特意改名而非沿用 `cutoff`：同为 number 时 TS 一个错都不报（#381）。
   */
  stuckAfterMs: number;
}

export interface BimpCreateParams {
  id: string;
  tenantId: string;
  personaId: string;
  ownerUserId: string;
  totalItems: number;
  deduplicateStrategy: BulkImportDeduplicateStrategy;
  now: number;
}

export interface BimpMarkRunningParams {
  jobId: string;
  /* ⚠️ issue #395：`started_at` 改由数据库盖戳（它是 reapStuck 的判定依据，
   * 必须与判定端同源），故此处不再收 `now`。 */
}

export interface BimpIncrementCounterParams {
  jobId: string;
  field: BulkImportCounterField;
  delta: number;
}

export interface BimpUpdateFailuresParams {
  jobId: string;
  failuresJson: string;
}

export interface BimpSetMetadataParams {
  jobId: string;
  metadataJson: string;
}

export interface BimpMarkCompletedParams {
  jobId: string;
  now: number;
}

export interface BimpMarkFailedParams {
  jobId: string;
  failuresJson: string;
  now: number;
}

export interface BimpFingerprintParams {
  tenantId: string;
  personaId: string;
  fingerprint: string;
}

/* ── Query 工厂 ── */

export function bimpQueryById(params: BimpByIdParams): Query<{ failures_json: string } | null, BimpByIdParams> {
  return { kind: BIMP_QUERY_BY_ID, params };
}

export function bimpQueryByTenantAndId(params: BimpByTenantAndIdParams): Query<BimpJobRow | null, BimpByTenantAndIdParams> {
  return { kind: BIMP_QUERY_BY_TENANT_AND_ID, params };
}

export function bimpQueryListByPersona(params: BimpListByPersonaParams): Query<BimpJobRow, BimpListByPersonaParams> {
  return { kind: BIMP_QUERY_LIST_BY_PERSONA, params };
}

export function bimpQueryFailures(params: BimpByIdParams): Query<BimpFailuresRow | null, BimpByIdParams> {
  return { kind: BIMP_QUERY_FAILURES, params };
}

export function bimpQueryStuck(params: BimpStuckParams): Query<BimpStuckRow, BimpStuckParams> {
  return { kind: BIMP_QUERY_STUCK, params };
}

/* ── Command 工厂 ── */

export function bimpCmdCreate(params: BimpCreateParams): Command<BimpCreateParams> {
  return { kind: BIMP_CMD_CREATE, params };
}

export function bimpCmdMarkRunning(params: BimpMarkRunningParams): Command<BimpMarkRunningParams> {
  return { kind: BIMP_CMD_MARK_RUNNING, params };
}

export function bimpCmdIncrementCounter(params: BimpIncrementCounterParams): Command<BimpIncrementCounterParams> {
  return { kind: BIMP_CMD_INCREMENT_COUNTER, params };
}

export function bimpCmdUpdateFailures(params: BimpUpdateFailuresParams): Command<BimpUpdateFailuresParams> {
  return { kind: BIMP_CMD_UPDATE_FAILURES, params };
}

export function bimpCmdSetMetadata(params: BimpSetMetadataParams): Command<BimpSetMetadataParams> {
  return { kind: BIMP_CMD_SET_METADATA, params };
}

export function bimpCmdMarkCompleted(params: BimpMarkCompletedParams): Command<BimpMarkCompletedParams> {
  return { kind: BIMP_CMD_MARK_COMPLETED, params };
}

export function bimpCmdMarkFailed(params: BimpMarkFailedParams): Command<BimpMarkFailedParams> {
  return { kind: BIMP_CMD_MARK_FAILED, params };
}

export function bimpQueryFindByFingerprint(params: BimpFingerprintParams): Query<{ id: string } | null, BimpFingerprintParams> {
  return { kind: BIMP_QUERY_FIND_BY_FINGERPRINT, params };
}

export function bimpCmdDeleteByFingerprint(params: BimpFingerprintParams): Command<BimpFingerprintParams> {
  return { kind: BIMP_CMD_DELETE_BY_FINGERPRINT, params };
}
