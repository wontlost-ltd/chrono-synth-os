/**
 * 人生模拟存储 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const LSIM_QUERY_BY_ID = 'lifeSim.byId' as const;
export const LSIM_QUERY_BY_ID_TENANT = 'lifeSim.byIdTenant' as const;
export const LSIM_QUERY_BY_TENANT = 'lifeSim.byTenant' as const;
export const LSIM_QUERY_COUNT_BY_TENANT = 'lifeSim.countByTenant' as const;
export const LSIM_QUERY_PAGINATED = 'lifeSim.paginated' as const;
export const LSIM_QUERY_PATH_DETAIL = 'lifeSim.pathDetail' as const;
export const LSIM_QUERY_PATH_DETAIL_TENANT = 'lifeSim.pathDetailTenant' as const;
export const LSIM_QUERY_VARIANTS = 'lifeSim.variants' as const;
export const LSIM_QUERY_VARIANTS_TENANT = 'lifeSim.variantsTenant' as const;
export const LSIM_QUERY_PATHS_BY_SIM = 'lifeSim.pathsBySim' as const;

/* ── Command Kinds ── */

export const LSIM_CMD_CREATE = 'lifeSim.create' as const;
export const LSIM_CMD_SET_STATUS = 'lifeSim.setStatus' as const;
export const LSIM_CMD_SET_STATUS_COMPLETED = 'lifeSim.setStatusCompleted' as const;
export const LSIM_CMD_UPDATE_PROGRESS = 'lifeSim.updateProgress' as const;
export const LSIM_CMD_SAVE_SUMMARY = 'lifeSim.saveSummary' as const;
export const LSIM_CMD_SAVE_PATH = 'lifeSim.savePath' as const;

/* ── 行类型 ── */

export interface LifeSimRow {
  id: string;
  tenant_id: string;
  task_id: string;
  base_simulation_id: string | null;
  config_json: string;
  status: string;
  summary_json: string | null;
  progress_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface LifeSimPathRow {
  id: string;
  simulation_id: string;
  path_id: string;
  label: string;
  status: string;
  summary_json: string | null;
  timeline_json: string | null;
  branches_json: string | null;
  retrospective_json: string | null;
  created_at: number;
  updated_at: number;
}

/* ── 参数类型 ── */

export interface LsimCreateParams {
  id: string;
  tenantId: string;
  taskId: string;
  baseSimulationId: string | null;
  configJson: string;
  now: number;
}

export interface LsimSetStatusParams {
  id: string;
  status: string;
  error: string | null;
  now: number;
}

export interface LsimSetStatusCompletedParams {
  id: string;
  status: string;
  error: string | null;
  now: number;
}

export interface LsimUpdateProgressParams {
  id: string;
  progressJson: string;
  now: number;
}

export interface LsimSaveSummaryParams {
  id: string;
  summaryJson: string;
  now: number;
}

export interface LsimSavePathParams {
  id: string;
  simulationId: string;
  pathId: string;
  label: string;
  summaryJson: string;
  timelineJson: string;
  branchesJson: string;
  now: number;
}

export interface LsimByIdTenantParams {
  id: string;
  tenantId: string;
}

export interface LsimByTenantParams {
  tenantId: string;
  limit: number;
}

export interface LsimPaginatedParams {
  tenantId: string;
  limit: number;
  offset: number;
}

export interface LsimPathDetailParams {
  simulationId: string;
  pathId: string;
}

export interface LsimPathDetailTenantParams {
  simulationId: string;
  pathId: string;
  tenantId: string;
}

export interface LsimVariantsParams {
  baseSimulationId: string;
}

export interface LsimVariantsTenantParams {
  baseSimulationId: string;
  tenantId: string;
}

/* ── Query 工厂 ── */

export function lsimQueryById(id: string): Query<LifeSimRow | null, string> {
  return { kind: LSIM_QUERY_BY_ID, params: id };
}

export function lsimQueryByIdTenant(id: string, tenantId: string): Query<LifeSimRow | null, LsimByIdTenantParams> {
  return { kind: LSIM_QUERY_BY_ID_TENANT, params: { id, tenantId } };
}

export function lsimQueryByTenant(tenantId: string, limit: number): Query<LifeSimRow, LsimByTenantParams> {
  return { kind: LSIM_QUERY_BY_TENANT, params: { tenantId, limit } };
}

export function lsimQueryCountByTenant(tenantId: string): Query<{ count: number } | null, string> {
  return { kind: LSIM_QUERY_COUNT_BY_TENANT, params: tenantId };
}

export function lsimQueryPaginated(tenantId: string, limit: number, offset: number): Query<LifeSimRow, LsimPaginatedParams> {
  return { kind: LSIM_QUERY_PAGINATED, params: { tenantId, limit, offset } };
}

export function lsimQueryPathDetail(simulationId: string, pathId: string): Query<LifeSimPathRow | null, LsimPathDetailParams> {
  return { kind: LSIM_QUERY_PATH_DETAIL, params: { simulationId, pathId } };
}

export function lsimQueryPathDetailTenant(simulationId: string, pathId: string, tenantId: string): Query<LifeSimPathRow | null, LsimPathDetailTenantParams> {
  return { kind: LSIM_QUERY_PATH_DETAIL_TENANT, params: { simulationId, pathId, tenantId } };
}

export function lsimQueryVariants(baseSimulationId: string): Query<LifeSimRow, LsimVariantsParams> {
  return { kind: LSIM_QUERY_VARIANTS, params: { baseSimulationId } };
}

export function lsimQueryVariantsTenant(baseSimulationId: string, tenantId: string): Query<LifeSimRow, LsimVariantsTenantParams> {
  return { kind: LSIM_QUERY_VARIANTS_TENANT, params: { baseSimulationId, tenantId } };
}

export function lsimQueryPathsBySim(simulationId: string): Query<LifeSimPathRow, string> {
  return { kind: LSIM_QUERY_PATHS_BY_SIM, params: simulationId };
}

/* ── Command 工厂 ── */

export function lsimCmdCreate(params: LsimCreateParams): Command<LsimCreateParams> {
  return { kind: LSIM_CMD_CREATE, params };
}

export function lsimCmdSetStatus(params: LsimSetStatusParams): Command<LsimSetStatusParams> {
  return { kind: LSIM_CMD_SET_STATUS, params };
}

export function lsimCmdSetStatusCompleted(params: LsimSetStatusCompletedParams): Command<LsimSetStatusCompletedParams> {
  return { kind: LSIM_CMD_SET_STATUS_COMPLETED, params };
}

export function lsimCmdUpdateProgress(params: LsimUpdateProgressParams): Command<LsimUpdateProgressParams> {
  return { kind: LSIM_CMD_UPDATE_PROGRESS, params };
}

export function lsimCmdSaveSummary(params: LsimSaveSummaryParams): Command<LsimSaveSummaryParams> {
  return { kind: LSIM_CMD_SAVE_SUMMARY, params };
}

export function lsimCmdSavePath(params: LsimSavePathParams): Command<LsimSavePathParams> {
  return { kind: LSIM_CMD_SAVE_PATH, params };
}
