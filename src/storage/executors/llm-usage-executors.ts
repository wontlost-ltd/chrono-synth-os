/**
 * LLM 用量记录 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  LLM_CMD_RECORD, LLM_QUERY_MONTHLY_SUMMARY, LLM_QUERY_RECENT, LLM_QUERY_PERIOD_TOTAL,
} from '@chrono/kernel';
import type {
  LlmUsageRow, LlmMonthlySummaryRow, LlmPeriodTotalRow,
  LlmRecordParams, LlmMonthlySummaryParams, LlmRecentParams, LlmPeriodTotalParams,
} from '@chrono/kernel';

export function registerLlmUsageExecutors(): void {
  registerCommand<LlmRecordParams>(LLM_CMD_RECORD, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO llm_usage (tenant_id, provider, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(p.tenantId, p.provider, p.model, p.inputTokens, p.outputTokens, p.totalTokens, p.estimatedCostUsd, p.now);
    return { rowsAffected: result.changes };
  });

  registerQuery<LlmMonthlySummaryRow | null, LlmMonthlySummaryParams>(LLM_QUERY_MONTHLY_SUMMARY, (db, p) => {
    const row = db.prepare<{ total_calls: number | bigint; total_tokens: number | bigint; total_input: number | bigint; total_output: number | bigint; total_cost: number }>(
      `SELECT COUNT(*) AS total_calls, COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(input_tokens), 0) AS total_input, COALESCE(SUM(output_tokens), 0) AS total_output,
       COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
       FROM llm_usage WHERE tenant_id = ? AND recorded_at >= ?`,
    ).get(p.tenantId, p.monthStartMs);
    if (!row) return null;
    return {
      total_calls: Number(row.total_calls),
      total_tokens: Number(row.total_tokens),
      total_input: Number(row.total_input),
      total_output: Number(row.total_output),
      total_cost: row.total_cost,
    };
  });

  registerQuery<readonly LlmUsageRow[], LlmRecentParams>(LLM_QUERY_RECENT, (db, p) => {
    return db.prepare<LlmUsageRow>(
      'SELECT * FROM llm_usage WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT ?',
    ).all(p.tenantId, p.limit);
  });

  registerQuery<LlmPeriodTotalRow | null, LlmPeriodTotalParams>(LLM_QUERY_PERIOD_TOTAL, (db, p) => {
    const row = db.prepare<{ total: number | bigint }>(
      'SELECT COALESCE(SUM(total_tokens), 0) AS total FROM llm_usage WHERE tenant_id = ? AND recorded_at >= ?',
    ).get(p.tenantId, p.sinceMs);
    if (!row) return null;
    return { total: Number(row.total) };
  });
}
