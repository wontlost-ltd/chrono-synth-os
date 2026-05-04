/**
 * 岗位人格模板 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const PTPL_QUERY_LIST = 'personaTemplate.list' as const;
export const PTPL_QUERY_BY_ID = 'personaTemplate.byId' as const;

/* ── Command Kinds ── */

export const PTPL_CMD_UPSERT_BUILTIN = 'personaTemplate.upsertBuiltin' as const;
export const PTPL_CMD_INSERT = 'personaTemplate.insert' as const;
export const PTPL_CMD_UPDATE = 'personaTemplate.update' as const;
export const PTPL_CMD_DELETE = 'personaTemplate.delete' as const;

/* ── 行类型 ── */

export interface PtplRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly category: string;
  readonly label: string;
  readonly description: string;
  readonly default_values_json: string;
  readonly default_narrative: string;
  readonly behavior_boundaries_json: string;
  readonly required_knowledge_categories_json: string;
  readonly is_builtin: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── 参数类型 ── */

export interface PtplListParams {
  tenantId: string;
  builtinTenantId: string;
}

export interface PtplByIdParams {
  templateId: string;
  tenantId: string;
  builtinTenantId: string;
}

export interface PtplUpsertBuiltinParams {
  id: string;
  tenantId: string;
  category: string;
  label: string;
  description: string;
  defaultValuesJson: string;
  defaultNarrative: string;
  behaviorBoundariesJson: string;
  requiredKnowledgeCategoriesJson: string;
  now: number;
}

export interface PtplInsertParams extends Omit<PtplUpsertBuiltinParams, 'now'> {
  createdAt: number;
  updatedAt: number;
}

export interface PtplUpdateParams {
  id: string;
  tenantId: string;
  label: string;
  description: string;
  defaultValuesJson: string;
  defaultNarrative: string;
  behaviorBoundariesJson: string;
  requiredKnowledgeCategoriesJson: string;
  updatedAt: number;
}

export interface PtplDeleteParams {
  templateId: string;
  tenantId: string;
}

/* ── Query 工厂 ── */

export function ptplQueryList(params: PtplListParams): Query<readonly PtplRow[], PtplListParams> {
  return { kind: PTPL_QUERY_LIST, params };
}

export function ptplQueryById(params: PtplByIdParams): Query<PtplRow | null, PtplByIdParams> {
  return { kind: PTPL_QUERY_BY_ID, params };
}

/* ── Command 工厂 ── */

export function ptplCmdUpsertBuiltin(params: PtplUpsertBuiltinParams): Command<PtplUpsertBuiltinParams> {
  return { kind: PTPL_CMD_UPSERT_BUILTIN, params };
}

export function ptplCmdInsert(params: PtplInsertParams): Command<PtplInsertParams> {
  return { kind: PTPL_CMD_INSERT, params };
}

export function ptplCmdUpdate(params: PtplUpdateParams): Command<PtplUpdateParams> {
  return { kind: PTPL_CMD_UPDATE, params };
}

export function ptplCmdDelete(params: PtplDeleteParams): Command<PtplDeleteParams> {
  return { kind: PTPL_CMD_DELETE, params };
}
