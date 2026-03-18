/**
 * 人格引擎 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const PENG_QUERY_BY_ID = 'personaEngine.byId' as const;
export const PENG_QUERY_ACTIVE = 'personaEngine.active' as const;
export const PENG_QUERY_ALL = 'personaEngine.all' as const;

/* ── Command Kinds ── */

export const PENG_CMD_CREATE = 'personaEngine.create' as const;
export const PENG_CMD_SET_STATUS = 'personaEngine.setStatus' as const;
export const PENG_CMD_SET_RESULTS = 'personaEngine.setResults' as const;
export const PENG_CMD_SET_QUOTA = 'personaEngine.setQuota' as const;
export const PENG_CMD_DELETE = 'personaEngine.delete' as const;
export const PENG_CMD_DELETE_ALL = 'personaEngine.deleteAll' as const;
export const PENG_CMD_INSERT_RAW = 'personaEngine.insertRaw' as const;

/* ── 行类型 ── */

export interface PengRow {
  readonly id: string;
  readonly label: string;
  readonly values_json: string;
  readonly status: string;
  readonly results_json: string;
  readonly resource_quota: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── 参数类型 ── */

export interface PengCreateParams {
  id: string;
  label: string;
  valuesJson: string;
  resourceQuota: number;
  now: number;
}

export interface PengSetStatusParams {
  id: string;
  status: string;
  now: number;
}

export interface PengSetResultsParams {
  id: string;
  resultsJson: string;
  now: number;
}

export interface PengSetQuotaParams {
  id: string;
  quota: number;
  now: number;
}

export interface PengInsertRawParams {
  id: string;
  label: string;
  valuesJson: string;
  status: string;
  resultsJson: string;
  resourceQuota: number;
  createdAt: number;
  updatedAt: number;
}

/* ── Query 工厂 ── */

export function pengQueryById(id: string): Query<PengRow | null, string> {
  return { kind: PENG_QUERY_BY_ID, params: id };
}

export function pengQueryActive(): Query<readonly PengRow[], void> {
  return { kind: PENG_QUERY_ACTIVE, params: undefined as unknown as void };
}

export function pengQueryAll(): Query<readonly PengRow[], void> {
  return { kind: PENG_QUERY_ALL, params: undefined as unknown as void };
}

/* ── Command 工厂 ── */

export function pengCmdCreate(params: PengCreateParams): Command<PengCreateParams> {
  return { kind: PENG_CMD_CREATE, params };
}

export function pengCmdSetStatus(params: PengSetStatusParams): Command<PengSetStatusParams> {
  return { kind: PENG_CMD_SET_STATUS, params };
}

export function pengCmdSetResults(params: PengSetResultsParams): Command<PengSetResultsParams> {
  return { kind: PENG_CMD_SET_RESULTS, params };
}

export function pengCmdSetQuota(params: PengSetQuotaParams): Command<PengSetQuotaParams> {
  return { kind: PENG_CMD_SET_QUOTA, params };
}

export function pengCmdDelete(id: string): Command<string> {
  return { kind: PENG_CMD_DELETE, params: id };
}

export function pengCmdDeleteAll(): Command<void> {
  return { kind: PENG_CMD_DELETE_ALL, params: undefined as unknown as void };
}

export function pengCmdInsertRaw(params: PengInsertRawParams): Command<PengInsertRawParams> {
  return { kind: PENG_CMD_INSERT_RAW, params };
}
