/**
 * Metrics Query Application Service
 * 封装指标端点的 DB 聚合查询——**跨 shard scatter-gather**（租户分片 Phase 0 · Plan 2 · Task 5）。
 *
 * 这些指标本就是**跨租户平台级聚合**（population diversity / rollup SUM / tenant usage Top-N），多 shard
 * 下不能只查 host DB（会只看到 home shard），须遍历 `resolver.allShardDbs()` 逐 shard 各查一份、协调层合并。
 * ctor 收单参 `resolver: TenantDbResolver`（非 `fromResolver/fromUnitOfWork` 二态）：单库下 `allShardDbs()=[db]`，
 * 行为等价现状，零回归。每方法返回 `ShardAggregate<T>`（`data` + `degraded` + `shardErrors`）——某 shard
 * 失败**只降级不静默当零、不整体抛**，调用方据 shardErrors 告警、data 仍是健康 shard 的部分聚合。
 *
 * 合并算法**因指标定死**：
 *  - population diversity：各 shard 原始 decision_style 行 concat → 协调层 `personalityDiversity(全部 styles)`
 *    **一次全局重算**（多样性是成对距离的群体统计，非各 shard 局部分数可加——局部 SUM 语义错）；
 *  - billing / queue：各 shard count SUM；
 *  - observability rollup：count SUM + `updated_at` 取 **MAX**（时间戳非累加量）；
 *  - tenant usage：各 shard 无-limit raw 行 concat → 全局 merge(同 tenant+resource SUM) + sort DESC + limit
 *    （各 shard 各 limit 会漏「跨 shard 求和后才进 Top-N」的租户）。
 */

import type { DecisionStyle, PersonalityDiversityResult } from '@chrono/kernel';
import {
  mtrxQueryQueueCount, mtrxQueryRollupSummary,
  mtrxQueryBillingOutboxCount, mtrxQueryTenantUsageRaw,
  decisionStyleListAll, DEFAULT_DECISION_STYLE, personalityDiversity,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { makeShardKeyer } from '../storage/shard-key.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { getObservabilityOutboxBacklog } from './observability-outbox.js';
import { aggregateShards, type ShardAggregate } from './shard-aggregate.js';

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

export interface ObservabilitySummaryResult {
  rollup: ObservabilitySummary;
  backlog: { pending: number; processing: number; failed: number };
}

export interface QueueBacklog {
  pending: number;
  running: number;
  failed: number;
}

export interface BillingOutboxBacklog {
  pending: number;
  failed: number;
}

export interface TenantUsageRow {
  tenant_id: string;
  resource: string;
  total: number;
}

/** rollup 各计数维度 SUM、`updated_at` 取 MAX（时间戳非累加量）。 */
function mergeObservabilitySummaries(parts: ObservabilitySummaryResult[]): ObservabilitySummaryResult {
  const acc: ObservabilitySummaryResult = {
    rollup: emptyObservabilitySummary(),
    backlog: { pending: 0, processing: 0, failed: 0 },
  };
  for (const part of parts) {
    acc.rollup.runtime_completed_count += part.rollup.runtime_completed_count;
    acc.rollup.runtime_duration_total_ms += part.rollup.runtime_duration_total_ms;
    acc.rollup.task_terminal_count += part.rollup.task_terminal_count;
    acc.rollup.task_success_count += part.rollup.task_success_count;
    acc.rollup.task_rejected_count += part.rollup.task_rejected_count;
    acc.rollup.task_disputed_count += part.rollup.task_disputed_count;
    acc.rollup.wallet_settlement_count += part.rollup.wallet_settlement_count;
    acc.rollup.wallet_settlement_total_amount_minor += part.rollup.wallet_settlement_total_amount_minor;
    acc.rollup.wallet_settlement_latency_total_ms += part.rollup.wallet_settlement_latency_total_ms;
    acc.rollup.governance_case_opened_count += part.rollup.governance_case_opened_count;
    acc.rollup.governance_case_active_count += part.rollup.governance_case_active_count;
    acc.rollup.governance_action_applied_count += part.rollup.governance_action_applied_count;
    acc.rollup.persona_growth_total += part.rollup.persona_growth_total;
    acc.rollup.persona_growth_event_count += part.rollup.persona_growth_event_count;
    acc.rollup.persona_reputation_delta_total += part.rollup.persona_reputation_delta_total;
    /* updated_at 是时间戳（各 shard rollup 的最后写入时刻），取 MAX 而非 SUM。 */
    acc.rollup.updated_at = Math.max(acc.rollup.updated_at, part.rollup.updated_at);
    acc.backlog.pending += part.backlog.pending;
    acc.backlog.processing += part.backlog.processing;
    acc.backlog.failed += part.backlog.failed;
  }
  return acc;
}

function emptyObservabilitySummary(): ObservabilitySummary {
  return {
    runtime_completed_count: 0,
    runtime_duration_total_ms: 0,
    task_terminal_count: 0,
    task_success_count: 0,
    task_rejected_count: 0,
    task_disputed_count: 0,
    wallet_settlement_count: 0,
    wallet_settlement_total_amount_minor: 0,
    wallet_settlement_latency_total_ms: 0,
    governance_case_opened_count: 0,
    governance_case_active_count: 0,
    governance_action_applied_count: 0,
    persona_growth_total: 0,
    persona_growth_event_count: 0,
    persona_reputation_delta_total: 0,
    updated_at: 0,
  };
}

/** 人群多样性 on-scrape 计算的 TTL 缓存（避免高频 scrape 反复全表扫 + O(n²) 阻塞 event loop）。 */
const DIVERSITY_CACHE_TTL_MS = 30_000;

export class MetricsQueryService {
  /* 多样性度量缓存：{ 计算时刻, ShardAggregate 结果 }；TTL 内复用，过期重算。null=未算过。 */
  private diversityCache: { computedAt: number; result: ShardAggregate<PersonalityDiversityResult> } | null = null;
  /* 每个服务实例持有自己的 keyer：同一 shard db 恒返稳定 shardKey（shard#0/shard#1/...），非数组下标。 */
  private readonly keyer = makeShardKeyer();

  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  getQueueBacklog(): ShardAggregate<QueueBacklog> {
    return aggregateShards<QueueBacklog, QueueBacklog>(
      this.resolver,
      this.keyer,
      (db) => ({
        pending: db.queryOne(mtrxQueryQueueCount('pending'))?.count ?? 0,
        running: db.queryOne(mtrxQueryQueueCount('running'))?.count ?? 0,
        failed: db.queryOne(mtrxQueryQueueCount('failed'))?.count ?? 0,
      }),
      (parts) => parts.reduce<QueueBacklog>((acc, p) => ({
        pending: acc.pending + p.pending,
        running: acc.running + p.running,
        failed: acc.failed + p.failed,
      }), { pending: 0, running: 0, failed: 0 }),
    );
  }

  getObservabilitySummary(): ShardAggregate<ObservabilitySummaryResult> {
    return aggregateShards<ObservabilitySummaryResult, ObservabilitySummaryResult>(
      this.resolver,
      this.keyer,
      (db) => {
        const rollupRow = db.queryOne(mtrxQueryRollupSummary());
        const backlog = getObservabilityOutboxBacklog(db);
        return {
          rollup: { ...emptyObservabilitySummary(), ...(rollupRow ?? {}) },
          backlog: {
            pending: toMetricNumber(backlog.pending),
            processing: toMetricNumber(backlog.processing),
            failed: toMetricNumber(backlog.failed),
          },
        };
      },
      mergeObservabilitySummaries,
    );
  }

  getBillingOutboxBacklog(): ShardAggregate<BillingOutboxBacklog> {
    return aggregateShards<BillingOutboxBacklog, BillingOutboxBacklog>(
      this.resolver,
      this.keyer,
      (db) => ({
        pending: db.queryOne(mtrxQueryBillingOutboxCount('pending'))?.count ?? 0,
        failed: db.queryOne(mtrxQueryBillingOutboxCount('failed'))?.count ?? 0,
      }),
      (parts) => parts.reduce<BillingOutboxBacklog>((acc, p) => ({
        pending: acc.pending + p.pending,
        failed: acc.failed + p.failed,
      }), { pending: 0, failed: 0 }),
    );
  }

  /**
   * 各 shard 拉无-limit raw 行 → 协调层全局 merge(同 tenant+resource SUM) + sort DESC + limit。
   * 各 shard 各 limit 会漏「跨 shard 求和后才进 Top-N」的租户，故 scatter 用 raw 变体、limit 只在协调层施加。
   */
  getTenantUsage(retentionMs: number, limit: number = 200): ShardAggregate<TenantUsageRow[]> {
    const cutoff = Date.now() - retentionMs;
    return aggregateShards<TenantUsageRow[], TenantUsageRow[]>(
      this.resolver,
      this.keyer,
      (db) => [...db.queryMany(mtrxQueryTenantUsageRaw({ cutoff }))],
      (parts) => {
        /* 全局 merge：同 (tenant_id, resource) 跨 shard SUM。 */
        const merged = new Map<string, TenantUsageRow>();
        for (const rows of parts) {
          for (const row of rows) {
            const key = `${row.tenant_id} ${row.resource}`;
            const existing = merged.get(key);
            if (existing) {
              existing.total += row.total;
            } else {
              merged.set(key, { tenant_id: row.tenant_id, resource: row.resource, total: row.total });
            }
          }
        }
        /* sort DESC by total（tie-break 按 tenant/resource 稳定，避免顺序抖动），再全局 limit。 */
        return [...merged.values()]
          .sort((a, b) => b.total - a.total
            || a.tenant_id.localeCompare(b.tenant_id)
            || a.resource.localeCompare(b.resource))
          .slice(0, limit);
      },
    );
  }

  /**
   * 平台级人群多样性度量（①度量 surface）：跨 **所有 shard** 读取 decision_style 原始行，concat 后
   * **一次全局重算** `personalityDiversity(全部 styles)`——多样性是群体成对距离统计，各 shard 局部分数不可
   * 相加（局部 SUM 语义错）。空/单人格时 diversityScore=0（kernel 纯函数已保证）。畸形 style_json 行被跳过。
   *
   * 性能：全表扫 + personalityDiversity 是 O(n²) 成对距离。/metrics 高频 scrape 时用 TTL 缓存避免反复
   * 重算阻塞 event loop——TTL 内复用上次 ShardAggregate（指标本就是慢变量，30s 陈旧可接受）。`now` 供测试注入。
   */
  getPopulationDiversity(now: number = Date.now()): ShardAggregate<PersonalityDiversityResult> {
    if (this.diversityCache && now - this.diversityCache.computedAt < DIVERSITY_CACHE_TTL_MS) {
      return this.diversityCache.result;
    }
    const result = aggregateShards<DecisionStyle[], PersonalityDiversityResult>(
      this.resolver,
      this.keyer,
      (db) => {
        const styles: DecisionStyle[] = [];
        for (const row of db.queryMany(decisionStyleListAll())) {
          if (!row.styleJson) continue;
          try {
            const parsed = JSON.parse(row.styleJson) as Partial<Omit<DecisionStyle, 'updatedAt'>>;
            /* 与 getDecisionStyle 同款：缺字段回退 DEFAULT，容忍旧/部分行。 */
            styles.push({ ...DEFAULT_DECISION_STYLE, ...parsed, updatedAt: 0 });
          } catch { /* 跳过畸形行，不污染群体度量 */ }
        }
        return styles;
      },
      /* 各 shard 原始 styles concat 后一次全局重算——非各 shard 各算 personalityDiversity 再合并。 */
      (parts) => personalityDiversity(parts.flat()),
    );
    this.diversityCache = { computedAt: now, result };
    return result;
  }
}

type MetricScalar = number | bigint | string | null | undefined;

export function toMetricNumber(value: MetricScalar): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
