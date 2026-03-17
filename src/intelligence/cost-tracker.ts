/**
 * LLM 成本追踪器 — 薄适配器
 * 成本计算委托 kernel 纯函数，DB 持久化留在此层
 */

import type { IDatabase } from '../storage/database.js';
import { estimateCost, type CostRecord } from '@chrono/kernel';

export type { CostRecord };

interface LlmUsageRow {
  readonly tenant_id: string;
  readonly provider: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly estimated_cost_usd: number;
  readonly recorded_at: number;
}

export class CostTracker {
  private readonly db: IDatabase | null;

  constructor(db?: IDatabase) {
    this.db = db ?? null;
  }

  /** 记录一次 LLM 调用 */
  record(tenantId: string, provider: string, model: string, inputTokens: number, outputTokens: number): CostRecord {
    const cost = estimateCost(model, inputTokens, outputTokens);
    const now = Date.now();

    const rec: CostRecord = {
      tenantId,
      provider,
      model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      totalTokens: cost.totalTokens,
      estimatedCostUsd: cost.estimatedCostUsd,
      timestamp: now,
    };

    if (this.db) {
      this.db.prepare<void>(
        'INSERT INTO llm_usage (tenant_id, provider, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(tenantId, provider, model, cost.inputTokens, cost.outputTokens, cost.totalTokens, cost.estimatedCostUsd, now);
    }

    return rec;
  }

  /** 按租户汇总本月费用 */
  getMonthlySummary(tenantId: string): {
    totalCalls: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCostUsd: number;
  } {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();

    if (this.db) {
      const row = this.db.prepare<{
        total_calls: number;
        total_tokens: number;
        total_input: number;
        total_output: number;
        total_cost: number;
      }>(
        `SELECT COUNT(*) AS total_calls, COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(input_tokens), 0) AS total_input, COALESCE(SUM(output_tokens), 0) AS total_output,
         COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
         FROM llm_usage WHERE tenant_id = ? AND recorded_at >= ?`,
      ).get(tenantId, monthStartMs);

      return {
        totalCalls: row?.total_calls ?? 0,
        totalTokens: row?.total_tokens ?? 0,
        totalInputTokens: row?.total_input ?? 0,
        totalOutputTokens: row?.total_output ?? 0,
        estimatedCostUsd: row?.total_cost ?? 0,
      };
    }

    return { totalCalls: 0, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0 };
  }

  /** 获取最近 N 条记录 */
  getRecent(tenantId: string, limit = 20): readonly CostRecord[] {
    if (this.db) {
      const rows = this.db.prepare<LlmUsageRow>(
        'SELECT * FROM llm_usage WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT ?',
      ).all(tenantId, limit);

      return rows.map(r => ({
        tenantId: r.tenant_id,
        provider: r.provider,
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        totalTokens: r.total_tokens,
        estimatedCostUsd: r.estimated_cost_usd,
        timestamp: r.recorded_at,
      }));
    }

    return [];
  }
}
