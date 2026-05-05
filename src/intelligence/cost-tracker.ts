/**
 * LLM 成本追踪器 — 薄适配器
 * 成本计算委托 kernel 纯函数，DB 持久化留在此层
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { estimateCost, type CostRecord } from '@chrono/kernel';
import {
  llmCmdRecord, llmQueryMonthlySummary, llmQueryRecent,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type { CostRecord };

export class CostTracker {
  private readonly tx: SyncWriteUnitOfWork | null;

  constructor(db?: IDatabase) {
    if (db) {
      registerCoreSelfExecutors();
      this.tx = db;
    } else {
      this.tx = null;
    }
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

    this.tx?.execute(llmCmdRecord({
      tenantId, provider, model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      totalTokens: cost.totalTokens,
      estimatedCostUsd: cost.estimatedCostUsd,
      now,
    }));

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
    if (this.tx) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const row = this.tx.queryOne(llmQueryMonthlySummary({ tenantId, monthStartMs: monthStart.getTime() }));
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
    if (this.tx) {
      const rows = this.tx.queryMany(llmQueryRecent({ tenantId, limit })) as unknown as Array<{
        tenant_id: string; provider: string; model: string;
        input_tokens: number; output_tokens: number; total_tokens: number;
        estimated_cost_usd: number; recorded_at: number;
      }>;
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
