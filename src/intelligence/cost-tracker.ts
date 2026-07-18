/**
 * LLM 成本追踪器 — 薄适配器
 * 成本计算委托 kernel 纯函数，DB 持久化留在此层。
 *
 * 双入口（租户分片 Phase 0，套用 QuotaManager 模式）：
 *   - fromResolver：未绑事务的长期服务（route 注册期）。per-tenant 经
 *     resolver.dbForTenant(tenantId) 选 db。CostTracker 无 cross-tenant 方法，故无 fan-out。
 *   - fromUnitOfWork：已进事务的调用链（测试 / 内存 db 单库语境）。所有操作固定用该事务，
 *     不重新解析 db（否则脱离事务）。
 * 因 IDatabase extends SyncWriteUnitOfWork，两模式内部统一到 SyncWriteUnitOfWork 接口，无适配层。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { estimateCost, type CostRecord } from '@chrono/kernel';
import {
  llmCmdRecord, llmQueryMonthlySummary, llmQueryRecent,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

export type { CostRecord };

/** 内部 db 取源：resolver 模式按 tenantId 解析；UoW 模式固定 tx。 */
interface MeterSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
}

export class CostTracker {
  private constructor(private readonly source: MeterSource) {
    registerCoreSelfExecutors();
  }

  /** resolver 模式：per-tenant→dbForTenant。用于 route 等未绑事务的长期服务。 */
  static fromResolver(resolver: TenantDbResolver): CostTracker {
    return new CostTracker({ forTenant: (t) => resolver.dbForTenant(t) });
  }

  /** bound-UoW 模式：固定用该事务，不重新解析 db。 */
  static fromUnitOfWork(tx: SyncWriteUnitOfWork): CostTracker {
    return new CostTracker({ forTenant: () => tx });
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

    this.source.forTenant(tenantId).execute(llmCmdRecord({
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
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const row = this.source.forTenant(tenantId).queryOne(llmQueryMonthlySummary({ tenantId, monthStartMs: monthStart.getTime() }));
    return {
      totalCalls: row?.total_calls ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      totalInputTokens: row?.total_input ?? 0,
      totalOutputTokens: row?.total_output ?? 0,
      estimatedCostUsd: row?.total_cost ?? 0,
    };
  }

  /** 获取最近 N 条记录 */
  getRecent(tenantId: string, limit = 20): readonly CostRecord[] {
    const rows = this.source.forTenant(tenantId).queryMany(llmQueryRecent({ tenantId, limit }));
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
}
