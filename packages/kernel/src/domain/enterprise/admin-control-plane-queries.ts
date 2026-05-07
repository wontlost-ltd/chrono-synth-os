/**
 * 管理控制台 Query kind 常量与参数类型（只读查询）
 */

import type { Query } from '../../ports/query.js';

/* ── Query Kinds ── */

export const ACP_QUERY_PERSONA_COUNT = 'acp.personaCount' as const;
export const ACP_QUERY_PERSONA_LIST = 'acp.personaList' as const;
export const ACP_QUERY_PERSONA_SUMMARY = 'acp.personaSummary' as const;
export const ACP_QUERY_TASK_COUNT = 'acp.taskCount' as const;
export const ACP_QUERY_TASK_LIST = 'acp.taskList' as const;
export const ACP_QUERY_TASK_SUMMARY = 'acp.taskSummary' as const;
export const ACP_QUERY_WALLET_COUNT = 'acp.walletCount' as const;
export const ACP_QUERY_WALLET_LIST = 'acp.walletList' as const;
export const ACP_QUERY_WALLET_SUMMARY = 'acp.walletSummary' as const;
export const ACP_QUERY_GOV_COUNT = 'acp.govCount' as const;
export const ACP_QUERY_GOV_LIST = 'acp.govList' as const;
export const ACP_QUERY_GOV_SUMMARY = 'acp.govSummary' as const;

/* ── 行类型 ── */

export interface AcpCountRow {
  readonly count: number;
}

export interface AcpPersonaRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly owner_email: string | null;
  readonly display_name: string;
  readonly status: string;
  readonly visibility: string;
  readonly growth_index: number;
  readonly reputation: number;
  readonly wallet_id: string | null;
  readonly wallet_balance: number | null;
  readonly wallet_token_balance: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AcpPersonaSummaryRow {
  readonly total: number;
  readonly active_count: number;
  readonly restricted_count: number;
  readonly deceased_count: number;
}

export interface AcpTaskRow {
  readonly id: string;
  readonly publisher_user_id: string;
  readonly publisher_email: string | null;
  readonly assignee_persona_id: string | null;
  readonly title: string;
  readonly category: string;
  readonly reward: number;
  readonly status: string;
  readonly quality_score: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export interface AcpTaskSummaryRow {
  readonly total: number;
  readonly open_count: number;
  readonly accepted_count: number;
  readonly completed_count: number;
  readonly disputed_count: number;
}

export interface AcpWalletRow {
  readonly id: string;
  readonly persona_id: string;
  readonly display_name: string | null;
  readonly balance: number;
  readonly token_balance: number;
  readonly currency: string;
  readonly status: string;
  readonly last_settled_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AcpWalletSummaryRow {
  readonly total: number;
  readonly active_count: number;
  readonly total_balance: number;
  readonly total_token_balance: number;
}

export interface AcpGovRow {
  readonly id: string;
  readonly persona_id: string;
  readonly display_name: string | null;
  readonly task_id: string | null;
  readonly trigger_type: string;
  readonly severity: string;
  readonly status: string;
  readonly opened_at: number;
  readonly resolved_at: number | null;
  readonly appealed_at: number | null;
}

export interface AcpGovSummaryRow {
  readonly total: number;
  readonly open_count: number;
  readonly action_applied_count: number;
  readonly appealed_count: number;
  readonly resolved_count: number;
}

/* ── 参数类型 ── */

export interface AcpFilterParams {
  tenantId: string;
  status: string | null;
}

export interface AcpPagedParams {
  tenantId: string;
  status: string | null;
  limit: number;
  offset: number;
}

/* ── Query 工厂 ── */

export function acpQueryPersonaCount(params: AcpFilterParams): Query<AcpCountRow | null, AcpFilterParams> {
  return { kind: ACP_QUERY_PERSONA_COUNT, params };
}

export function acpQueryPersonaList(params: AcpPagedParams): Query<AcpPersonaRow, AcpPagedParams> {
  return { kind: ACP_QUERY_PERSONA_LIST, params };
}

export function acpQueryPersonaSummary(tenantId: string): Query<AcpPersonaSummaryRow | null, string> {
  return { kind: ACP_QUERY_PERSONA_SUMMARY, params: tenantId };
}

export function acpQueryTaskCount(params: AcpFilterParams): Query<AcpCountRow | null, AcpFilterParams> {
  return { kind: ACP_QUERY_TASK_COUNT, params };
}

export function acpQueryTaskList(params: AcpPagedParams): Query<AcpTaskRow, AcpPagedParams> {
  return { kind: ACP_QUERY_TASK_LIST, params };
}

export function acpQueryTaskSummary(tenantId: string): Query<AcpTaskSummaryRow | null, string> {
  return { kind: ACP_QUERY_TASK_SUMMARY, params: tenantId };
}

export function acpQueryWalletCount(params: AcpFilterParams): Query<AcpCountRow | null, AcpFilterParams> {
  return { kind: ACP_QUERY_WALLET_COUNT, params };
}

export function acpQueryWalletList(params: AcpPagedParams): Query<AcpWalletRow, AcpPagedParams> {
  return { kind: ACP_QUERY_WALLET_LIST, params };
}

export function acpQueryWalletSummary(tenantId: string): Query<AcpWalletSummaryRow | null, string> {
  return { kind: ACP_QUERY_WALLET_SUMMARY, params: tenantId };
}

export function acpQueryGovCount(params: AcpFilterParams): Query<AcpCountRow | null, AcpFilterParams> {
  return { kind: ACP_QUERY_GOV_COUNT, params };
}

export function acpQueryGovList(params: AcpPagedParams): Query<AcpGovRow, AcpPagedParams> {
  return { kind: ACP_QUERY_GOV_LIST, params };
}

export function acpQueryGovSummary(tenantId: string): Query<AcpGovSummaryRow | null, string> {
  return { kind: ACP_QUERY_GOV_SUMMARY, params: tenantId };
}
