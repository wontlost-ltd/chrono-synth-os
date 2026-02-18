/**
 * LLM 成本追踪器
 * 按租户记录 LLM 调用次数、token 用量和估算成本
 * 支持 DB 持久化（优先）和内存回退
 */

import type { IDatabase } from '../storage/database.js';

export interface CostRecord {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  timestamp: number;
}

/** 每 1K token 的美元价格（近似值） */
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'claude-sonnet-4-5-20250929': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5-20251001': { input: 0.0008, output: 0.004 },
  'mock': { input: 0, output: 0 },
};

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
    const safeInput = Math.max(0, Math.trunc(inputTokens) || 0);
    const safeOutput = Math.max(0, Math.trunc(outputTokens) || 0);
    const prices = TOKEN_PRICES[model] ?? { input: 0.001, output: 0.005 };
    const estimatedCostUsd = (safeInput / 1000) * prices.input + (safeOutput / 1000) * prices.output;
    const totalTokens = safeInput + safeOutput;
    const now = Date.now();

    const rec: CostRecord = {
      tenantId,
      provider,
      model,
      inputTokens: safeInput,
      outputTokens: safeOutput,
      totalTokens,
      estimatedCostUsd,
      timestamp: now,
    };

    if (this.db) {
      this.db.prepare<void>(
        'INSERT INTO llm_usage (tenant_id, provider, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(tenantId, provider, model, safeInput, safeOutput, totalTokens, estimatedCostUsd, now);
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
