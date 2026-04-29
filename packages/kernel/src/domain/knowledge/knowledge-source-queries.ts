/**
 * 知识源 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const KSRC_QUERY_BY_ID = 'knowledgeSource.byId' as const;
export const KSRC_QUERY_LIST = 'knowledgeSource.list' as const;
export const KSRC_QUERY_COUNT = 'knowledgeSource.count' as const;
export const KSRC_QUERY_ENABLED_BY_IDS = 'knowledgeSource.enabledByIds' as const;

/* ── Command Kinds ── */

export const KSRC_CMD_CREATE = 'knowledgeSource.create' as const;
export const KSRC_CMD_UPDATE = 'knowledgeSource.update' as const;
export const KSRC_CMD_UPDATE_STATE = 'knowledgeSource.updateState' as const;
export const KSRC_CMD_DELETE = 'knowledgeSource.delete' as const;

/* ── 行类型 ── */

export interface KsrcRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly name: string;
  readonly enabled: number;
  readonly config_json: string;
  readonly state_json: string | null;
  readonly last_ingested_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface KsrcCountRow {
  readonly count: number;
}

/* ── 参数类型 ── */

export interface KsrcByIdParams {
  id: string;
  tenantId: string;
}

export interface KsrcListParams {
  tenantId: string;
  limit: number;
  offset: number;
}

export interface KsrcEnabledByIdsParams {
  tenantId: string;
  ids: string[];
}

export interface KsrcCreateParams {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  configJson: string;
  now: number;
}

export interface KsrcUpdateParams {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  configJson: string;
  enabled: number;
  now: number;
}

export interface KsrcUpdateStateParams {
  id: string;
  stateJson: string | null;
  lastIngestedAt: number;
  now: number;
}

/* ── Query 工厂 ── */

export function ksrcQueryById(params: KsrcByIdParams): Query<KsrcRow | null, KsrcByIdParams> {
  return { kind: KSRC_QUERY_BY_ID, params };
}

export function ksrcQueryList(params: KsrcListParams): Query<readonly KsrcRow[], KsrcListParams> {
  return { kind: KSRC_QUERY_LIST, params };
}

export function ksrcQueryCount(tenantId: string): Query<KsrcCountRow | null, string> {
  return { kind: KSRC_QUERY_COUNT, params: tenantId };
}

export function ksrcQueryEnabledByIds(params: KsrcEnabledByIdsParams): Query<readonly KsrcRow[], KsrcEnabledByIdsParams> {
  return { kind: KSRC_QUERY_ENABLED_BY_IDS, params };
}

/* ── Command 工厂 ── */

export function ksrcCmdCreate(params: KsrcCreateParams): Command<KsrcCreateParams> {
  return { kind: KSRC_CMD_CREATE, params };
}

export function ksrcCmdUpdate(params: KsrcUpdateParams): Command<KsrcUpdateParams> {
  return { kind: KSRC_CMD_UPDATE, params };
}

export function ksrcCmdUpdateState(params: KsrcUpdateStateParams): Command<KsrcUpdateStateParams> {
  return { kind: KSRC_CMD_UPDATE_STATE, params };
}

export function ksrcCmdDelete(params: KsrcByIdParams): Command<KsrcByIdParams> {
  return { kind: KSRC_CMD_DELETE, params };
}
