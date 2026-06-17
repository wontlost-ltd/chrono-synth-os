/**
 * Metrics Query Application Service
 * 封装指标端点的 DB 聚合查询
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { MtrxRollupRow, DecisionStyle, PersonalityDiversityResult } from '@chrono/kernel';
import {
  mtrxQueryQueueCount, mtrxQueryRollupSummary,
  mtrxQueryBillingOutboxCount, mtrxQueryTenantUsage,
  decisionStyleListAll, DEFAULT_DECISION_STYLE, personalityDiversity,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getObservabilityOutboxBacklog } from './observability-outbox.js';

type MetricScalar = number | bigint | string | null | undefined;

export interface ObservabilitySummary {
  runtime_completed_count: number;
  runtime_duration_total_ms: number;
  task_terminal_count: number;
  task_success_count: number;
  task_rejected_count: number;
  task_disputed_count: number;
  wallet_settlement_count: number;
  wallet_settlement_total_amount_minor: number;
  wallet_settlement_latency_total_ms: number;
  governance_case_opened_count: number;
  governance_case_active_count: number;
  governance_action_applied_count: number;
  persona_growth_total: number;
  persona_growth_event_count: number;
  persona_reputation_delta_total: number;
  updated_at: number;
}

export function toMetricNumber(value: MetricScalar): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function rollupRowToSummary(row?: MtrxRollupRow | null): ObservabilitySummary {
  return {
    runtime_completed_count: row?.runtime_completed_count ?? 0,
    runtime_duration_total_ms: row?.runtime_duration_total_ms ?? 0,
    task_terminal_count: row?.task_terminal_count ?? 0,
    task_success_count: row?.task_success_count ?? 0,
    task_rejected_count: row?.task_rejected_count ?? 0,
    task_disputed_count: row?.task_disputed_count ?? 0,
    wallet_settlement_count: row?.wallet_settlement_count ?? 0,
    wallet_settlement_total_amount_minor: row?.wallet_settlement_total_amount_minor ?? 0,
    wallet_settlement_latency_total_ms: row?.wallet_settlement_latency_total_ms ?? 0,
    governance_case_opened_count: row?.governance_case_opened_count ?? 0,
    governance_case_active_count: row?.governance_case_active_count ?? 0,
    governance_action_applied_count: row?.governance_action_applied_count ?? 0,
    persona_growth_total: row?.persona_growth_total ?? 0,
    persona_growth_event_count: row?.persona_growth_event_count ?? 0,
    persona_reputation_delta_total: row?.persona_reputation_delta_total ?? 0,
    updated_at: row?.updated_at ?? 0,
  };
}

/** 人群多样性 on-scrape 计算的 TTL 缓存（避免高频 scrape 反复全表扫 + O(n²) 阻塞 event loop）。 */
const DIVERSITY_CACHE_TTL_MS = 30_000;

export class MetricsQueryService {
  /* 多样性度量缓存：{ 计算时刻, 结果 }；TTL 内复用，过期重算。null=未算过。 */
  private diversityCache: { computedAt: number; result: PersonalityDiversityResult } | null = null;

  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  getQueueBacklog(): { pending: number; running: number; failed: number } {
    try {
      const pending = this.tx.queryOne(mtrxQueryQueueCount('pending'))?.count ?? 0;
      const running = this.tx.queryOne(mtrxQueryQueueCount('running'))?.count ?? 0;
      const failed = this.tx.queryOne(mtrxQueryQueueCount('failed'))?.count ?? 0;
      return { pending, running, failed };
    } catch { return { pending: 0, running: 0, failed: 0 }; }
  }

  getObservabilitySummary(): { rollup: ObservabilitySummary; backlog: { pending: number; processing: number; failed: number } } {
    try {
      const rollupRow = this.tx.queryOne(mtrxQueryRollupSummary());
      const backlog = getObservabilityOutboxBacklog(this.tx);
      return {
        rollup: rollupRowToSummary(rollupRow),
        backlog: {
          pending: toMetricNumber(backlog.pending),
          processing: toMetricNumber(backlog.processing),
          failed: toMetricNumber(backlog.failed),
        },
      };
    } catch {
      return {
        rollup: rollupRowToSummary(),
        backlog: { pending: 0, processing: 0, failed: 0 },
      };
    }
  }

  getBillingOutboxBacklog(): { pending: number; failed: number } {
    try {
      const pending = this.tx.queryOne(mtrxQueryBillingOutboxCount('pending'))?.count ?? 0;
      const failed = this.tx.queryOne(mtrxQueryBillingOutboxCount('failed'))?.count ?? 0;
      return { pending, failed };
    } catch { return { pending: 0, failed: 0 }; }
  }

  getTenantUsage(retentionMs: number, limit: number = 200): Array<{ tenant_id: string; resource: string; total: number }> {
    try {
      const cutoff = Date.now() - retentionMs;
      const rows = this.tx.queryMany(mtrxQueryTenantUsage({ cutoff, limit }));
      return [...rows];
    } catch { return []; }
  }

  /**
   * 平台级人群多样性度量（①度量 surface）：跨租户读取所有 decision_style，计算 personalityDiversity。
   * decision_style PK=tenant_id（每租户一份决策风格），故「人群多样性」是跨租户群体统计——平台运营者
   * 视角的合法全局聚合（同 getTenantUsage）。空/单租户时 diversityScore=0（kernel 纯函数已保证）。
   * 畸形 style_json 行被跳过（不污染度量），而非整体失败。
   *
   * 性能：全表扫 + personalityDiversity 是 O(n²) 成对距离。/metrics 高频 scrape 时用 TTL 缓存避免反复
   * 重算阻塞 event loop——TTL 内复用上次结果（指标本就是慢变量，30s 陈旧可接受）。`now` 供测试注入。
   */
  getPopulationDiversity(now: number = Date.now()): PersonalityDiversityResult {
    if (this.diversityCache && now - this.diversityCache.computedAt < DIVERSITY_CACHE_TTL_MS) {
      return this.diversityCache.result;
    }
    const result = this.computePopulationDiversity();
    this.diversityCache = { computedAt: now, result };
    return result;
  }

  private computePopulationDiversity(): PersonalityDiversityResult {
    try {
      const rows = this.tx.queryMany(decisionStyleListAll());
      const styles: DecisionStyle[] = [];
      for (const row of rows) {
        if (!row.styleJson) continue;
        try {
          const parsed = JSON.parse(row.styleJson) as Partial<Omit<DecisionStyle, 'updatedAt'>>;
          /* 与 getDecisionStyle 同款：缺字段回退 DEFAULT，容忍旧/部分行。 */
          styles.push({ ...DEFAULT_DECISION_STYLE, ...parsed, updatedAt: 0 });
        } catch { /* 跳过畸形行，不污染群体度量 */ }
      }
      return personalityDiversity(styles);
    } catch {
      return personalityDiversity([]);
    }
  }
}
