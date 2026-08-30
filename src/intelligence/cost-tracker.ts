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
    /* ⚠️ 审计 #434：月度边界必须用 **UTC**，与 token-budget 保持一致。
     *
     * 此前用 `setDate(1) + setHours(0,0,0,0)` 是**本机时区**的月初，而
     * `token-budget.ts` 的 `getMonth()` 用 `toISOString().slice(0,7)` 是 **UTC**。
     * 两者读同一张 `llm_usage` 表：UTC+14 主机上相差 **14 小时**。
     * 跨月边界时预算门认为已进新月（额度重置）而成本统计仍算上月 —— 或反之：
     * 租户可能在边界窗口内拿到双倍额度，或被错误拒绝。
     *
     * 统一到 UTC（而非本地时区）的理由：token-budget 的 key 是字符串
     * `YYYY-MM`，改它要动持久化的 usage key 语义；改本处只是查询边界，
     * 影响面最小且方向正确（服务端计量本就该用 UTC）。 */
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
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
