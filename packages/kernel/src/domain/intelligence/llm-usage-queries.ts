/**
 * LLM 用量记录 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Command Kinds ── */

export const LLM_CMD_RECORD = 'llmUsage.record' as const;

/* ── Query Kinds ── */

export const LLM_QUERY_MONTHLY_SUMMARY = 'llmUsage.monthlySummary' as const;
export const LLM_QUERY_RECENT = 'llmUsage.recent' as const;
export const LLM_QUERY_PERIOD_TOTAL = 'llmUsage.periodTotal' as const;

/* ── 行类型 ── */

export interface LlmUsageRow {
  readonly tenant_id: string;
  readonly provider: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly estimated_cost_usd: number;
  readonly recorded_at: number;
}

export interface LlmMonthlySummaryRow {
  readonly total_calls: number;
  readonly total_tokens: number;
  readonly total_input: number;
  readonly total_output: number;
  readonly total_cost: number;
}

export interface LlmPeriodTotalRow {
  readonly total: number;
}

/* ── 参数类型 ── */

export interface LlmRecordParams {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  now: number;
}

export interface LlmMonthlySummaryParams {
  tenantId: string;
  monthStartMs: number;
}

export interface LlmRecentParams {
  tenantId: string;
  limit: number;
}

export interface LlmPeriodTotalParams {
  tenantId: string;
  sinceMs: number;
}

/* ── Command 工厂 ── */

export function llmCmdRecord(params: LlmRecordParams): Command<LlmRecordParams> {
  return { kind: LLM_CMD_RECORD, params };
}

/* ── Query 工厂 ── */

export function llmQueryMonthlySummary(params: LlmMonthlySummaryParams): Query<LlmMonthlySummaryRow | null, LlmMonthlySummaryParams> {
  return { kind: LLM_QUERY_MONTHLY_SUMMARY, params };
}

export function llmQueryRecent(params: LlmRecentParams): Query<LlmUsageRow, LlmRecentParams> {
  return { kind: LLM_QUERY_RECENT, params };
}

export function llmQueryPeriodTotal(params: LlmPeriodTotalParams): Query<LlmPeriodTotalRow | null, LlmPeriodTotalParams> {
  return { kind: LLM_QUERY_PERIOD_TOTAL, params };
}
