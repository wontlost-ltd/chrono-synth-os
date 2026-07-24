/**
 * 指标端点
 * GET /metrics — JSON 格式运行时指标
 * GET /metrics/prometheus — Prometheus text exposition 格式
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { getMetricsSnapshot, getTotalRequests } from '../plugins/metrics.js';
import { getWsConnectionCount } from '../plugins/websocket.js';
import { billingMetrics } from '../../billing/billing-outbox.js';
import { mediaRetentionMetrics } from '../../perception/media/media-retention-worker.js';
import { llmMetrics } from '../../intelligence/model-router.js';
import { safetyMetrics } from '../../intelligence/llm-safety.js';
import { calculatePercentile } from '../plugins/metrics.js';
import { observabilityPipelineMetrics } from '../../observability/observability-outbox.js';
import { MetricsQueryService } from '../../observability/metrics-query-service.js';
import type { ShardAggregate } from '../../observability/shard-aggregate.js';

/**
 * 折叠一次 scrape 里多个 scatter-gather 聚合的降级信号：任一聚合有 shard 失败 → degraded，
 * 各聚合的 shardErrors 汇总（同 shardKey 去重，避免同一坏 shard 在 5 个聚合里重复 5 次）。
 */
class ShardHealthCollector {
  private readonly byShard = new Map<string, string>();

  /** 记录一次聚合的降级明细，返回其 data（解包）。 */
  take<T>(aggregate: ShardAggregate<T>): T {
    for (const { shardKey, error } of aggregate.shardErrors) {
      if (!this.byShard.has(shardKey)) this.byShard.set(shardKey, error);
    }
    return aggregate.data;
  }

  get degraded(): boolean {
    return this.byShard.size > 0;
  }

  get failureCount(): number {
    return this.byShard.size;
  }

  get shardErrors(): Array<{ shardKey: string; error: string }> {
    return [...this.byShard.entries()].map(([shardKey, error]) => ({ shardKey, error }));
  }
}

function llmLatencyPercentiles(arr: number[]): { p50: number; p90: number; p99: number } {
  if (arr.length === 0) return { p50: 0, p90: 0, p99: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    p50: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
    p90: Math.round(calculatePercentile(sorted, 90) * 100) / 100,
    p99: Math.round(calculatePercentile(sorted, 99) * 100) / 100,
  };
}

function safeAverage(total: number, count: number): number {
  if (count <= 0) return 0;
  return Math.round((total / count) * 100) / 100;
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

const startTime = Date.now();

export function registerMetricsRoutes(app: FastifyInstance, os: ChronoSynthOS, resolver: TenantDbResolver, config?: AppConfig): void {
  const retentionMs = config?.observability.metricsRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  /* 跨租户聚合走 resolver.allShardDbs() scatter-gather（单库下=[db]，行为等价现状）。 */
  const metricsService = new MetricsQueryService(resolver);

  app.get('/metrics', async () => {
    const mem = process.memoryUsage();
    /* 本次 scrape 的 shard 健康折叠：解包各聚合 data，汇总 degraded/shardErrors。 */
    const health = new ShardHealthCollector();
    const outbox = health.take(metricsService.getBillingOutboxBacklog());
    const observability = health.take(metricsService.getObservabilitySummary());
    const runtimeAvgDuration = safeAverage(observability.rollup.runtime_duration_total_ms, observability.rollup.runtime_completed_count);
    const taskSuccessRate = safeRate(observability.rollup.task_success_count, observability.rollup.task_terminal_count);
    const walletSettlementLatency = safeAverage(observability.rollup.wallet_settlement_latency_total_ms, observability.rollup.wallet_settlement_count);
    const personaGrowthAvg = safeAverage(observability.rollup.persona_growth_total, observability.rollup.persona_growth_event_count);

    return {
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      requests: { total: getTotalRequests(), by_endpoint: getMetricsSnapshot() },
      business: {
        persona_count: os.accelerated.getAllPersonas().length,
        conflict_count: os.meta.conflicts.getUnresolved().length,
        snapshot_count: os.snapshots.list().length,
        /* ①度量 surface：平台人群多样性（跨租户 decision_style 群体统计）。
         * initialized_population = 已写过决策风格 row 的租户数（懒默认租户不计入）。 */
        population_diversity: (() => {
          const d = health.take(metricsService.getPopulationDiversity());
          return {
            initialized_population: d.count,
            diversity_score: Math.round(d.diversityScore * 10_000) / 10_000,
            per_dimension_spread: d.perDimensionSpread,
            per_dimension_mean: d.perDimensionMean,
          };
        })(),
      },
      billing: {
        meter_events_enqueued: billingMetrics.meterEventsEnqueued,
        meter_events_processed: billingMetrics.meterEventsProcessed,
        meter_events_failed: billingMetrics.meterEventsFailed,
        outbox_pending: outbox.pending,
        outbox_failed: outbox.failed,
      },
      /* 感知媒体 retention（GDPR Art.17 fan-out）：坏 shard 擦除失败计数 + 降级状态。
       * 唯一来源=模块级 mediaRetentionMetrics（worker flushOnce 写、此处只读，不经 worker 实例）。 */
      media_retention: {
        shard_erase_failures: mediaRetentionMetrics.shardEraseFailures,
        degraded: mediaRetentionMetrics.degraded,
      },
      llm: {
        chat_calls: llmMetrics.chatCalls,
        chat_errors: llmMetrics.chatErrors,
        chat_latency_ms: llmLatencyPercentiles(llmMetrics.chatLatencyMs),
        embed_calls: llmMetrics.embedCalls,
        embed_errors: llmMetrics.embedErrors,
        embed_latency_ms: llmLatencyPercentiles(llmMetrics.embedLatencyMs),
        total_tokens_consumed: llmMetrics.totalTokensConsumed,
        /* ADR-0047 D2：主 provider 不可用→降级到下一档的次数。 */
        fallbacks: llmMetrics.fallbacks,
        safety: {
          input_checks: safetyMetrics.inputChecks,
          input_blocked: safetyMetrics.inputBlocked,
          output_checks: safetyMetrics.outputChecks,
          output_sanitized: safetyMetrics.outputSanitized,
        },
      },
      observability: {
        pipeline: {
          events_enqueued: observabilityPipelineMetrics.eventsEnqueued,
          events_processed: observabilityPipelineMetrics.eventsProcessed,
          events_failed: observabilityPipelineMetrics.eventsFailed,
          events_recovered: observabilityPipelineMetrics.eventsRecovered,
          outbox_pending: observability.backlog.pending,
          outbox_processing: observability.backlog.processing,
          outbox_failed: observability.backlog.failed,
        },
        runtime: { completed_count: observability.rollup.runtime_completed_count, avg_duration_ms: runtimeAvgDuration },
        tasks: {
          terminal_count: observability.rollup.task_terminal_count,
          success_count: observability.rollup.task_success_count,
          rejected_count: observability.rollup.task_rejected_count,
          disputed_count: observability.rollup.task_disputed_count,
          success_rate: taskSuccessRate,
        },
        wallet: {
          settlement_count: observability.rollup.wallet_settlement_count,
          settlement_total_amount_minor: observability.rollup.wallet_settlement_total_amount_minor,
          avg_settlement_latency_ms: walletSettlementLatency,
        },
        governance: {
          opened_count: observability.rollup.governance_case_opened_count,
          active_count: observability.rollup.governance_case_active_count,
          action_applied_count: observability.rollup.governance_action_applied_count,
        },
        persona: {
          growth_total: observability.rollup.persona_growth_total,
          growth_event_count: observability.rollup.persona_growth_event_count,
          avg_growth_delta: personaGrowthAvg,
          reputation_delta_total: observability.rollup.persona_reputation_delta_total,
        },
        last_updated_at: observability.rollup.updated_at > 0 ? new Date(observability.rollup.updated_at).toISOString() : null,
      },
      queue: health.take(metricsService.getQueueBacklog()),
      system: {
        memory_mb: {
          rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        },
        ws_connections_active: getWsConnectionCount(),
      },
      /* 跨 shard scatter-gather 健康：degraded=有 shard 失败（本次 scrape 是部分聚合）；
       * shardErrors 逐坏-shard 明细（稳定 shardKey）。单库/全 shard 健康时 degraded=false、shardErrors=[]。 */
      sharding: {
        degraded: health.degraded,
        shard_failures: health.failureCount,
        shard_errors: health.shardErrors,
      },
    };
  });

  app.get('/metrics/prometheus', async (_request, reply) => {
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const snapshot = getMetricsSnapshot();
    const totalRequests = getTotalRequests();
    const personaCount = os.accelerated.getAllPersonas().length;
    const conflictCount = os.meta.conflicts.getUnresolved().length;
    const snapshotCount = os.snapshots.list().length;
    /* 本次 scrape 的 shard 健康折叠（同 JSON 端点），最后暴露 degraded gauge + shard failure counter。 */
    const health = new ShardHealthCollector();
    const observability = health.take(metricsService.getObservabilitySummary());
    const runtimeAvgDuration = safeAverage(observability.rollup.runtime_duration_total_ms, observability.rollup.runtime_completed_count);
    const taskSuccessRate = safeRate(observability.rollup.task_success_count, observability.rollup.task_terminal_count);
    const walletSettlementLatency = safeAverage(observability.rollup.wallet_settlement_latency_total_ms, observability.rollup.wallet_settlement_count);
    const personaGrowthAvg = safeAverage(observability.rollup.persona_growth_total, observability.rollup.persona_growth_event_count);

    const lines: string[] = [];

    lines.push('# HELP chrono_uptime_seconds 服务运行时间（秒）');
    lines.push('# TYPE chrono_uptime_seconds gauge');
    lines.push(`chrono_uptime_seconds ${uptimeSeconds}`);
    lines.push('# HELP chrono_process_memory_bytes 进程内存使用');
    lines.push('# TYPE chrono_process_memory_bytes gauge');
    lines.push(`chrono_process_memory_bytes{type="rss"} ${mem.rss}`);
    lines.push(`chrono_process_memory_bytes{type="heap_used"} ${mem.heapUsed}`);
    lines.push(`chrono_process_memory_bytes{type="heap_total"} ${mem.heapTotal}`);
    lines.push('# HELP chrono_http_requests_total HTTP 请求总数');
    lines.push('# TYPE chrono_http_requests_total counter');
    lines.push(`chrono_http_requests_total ${totalRequests}`);
    lines.push('# HELP chrono_http_request_duration_ms HTTP 请求延迟百分位');
    lines.push('# TYPE chrono_http_request_duration_ms summary');
    for (const [endpoint, stats] of Object.entries(snapshot)) {
      const [method, ...pathParts] = endpoint.split(' ');
      const path = pathParts.join(' ');
      const labels = `method="${method}",path="${path}"`;
      lines.push(`chrono_http_request_duration_ms{${labels},quantile="0.5"} ${stats.p50_ms}`);
      lines.push(`chrono_http_request_duration_ms{${labels},quantile="0.9"} ${stats.p90_ms}`);
      lines.push(`chrono_http_request_duration_ms{${labels},quantile="0.99"} ${stats.p99_ms}`);
      lines.push(`chrono_http_request_duration_ms_count{${labels}} ${stats.count}`);
    }
    lines.push('# HELP chrono_personas_total 人格版本总数');
    lines.push('# TYPE chrono_personas_total gauge');
    lines.push(`chrono_personas_total ${personaCount}`);
    lines.push('# HELP chrono_conflicts_unresolved 未解决冲突数');
    lines.push('# TYPE chrono_conflicts_unresolved gauge');
    lines.push(`chrono_conflicts_unresolved ${conflictCount}`);
    lines.push('# HELP chrono_snapshots_total 快照总数');
    lines.push('# TYPE chrono_snapshots_total gauge');
    lines.push(`chrono_snapshots_total ${snapshotCount}`);
    /* ①度量 surface：平台人群多样性（跨租户 decision_style 群体统计）。 */
    const diversity = health.take(metricsService.getPopulationDiversity());
    /* 口径：population = **已初始化 decision_style row** 的租户数，非全部租户——懒默认（从未写过
     * 决策风格）的租户不计入，也不参与多样性。指标名带 _initialized_ 明确这一口径，避免误读为总租户数。 */
    lines.push('# HELP chrono_persona_population_initialized_total 已初始化决策风格的人格数（跨租户，多样性度量基数；不含懒默认租户）');
    lines.push('# TYPE chrono_persona_population_initialized_total gauge');
    lines.push(`chrono_persona_population_initialized_total ${diversity.count}`);
    lines.push('# HELP chrono_persona_diversity_score 平台人群性格多样性 [0,1]（0=全同，越大越分散；基于已初始化人格）');
    lines.push('# TYPE chrono_persona_diversity_score gauge');
    lines.push(`chrono_persona_diversity_score ${Math.round(diversity.diversityScore * 10_000) / 10_000}`);
    lines.push('# HELP chrono_persona_diversity_dimension_spread 各决策维度归一化 spread（指出多样性来源维度）');
    lines.push('# TYPE chrono_persona_diversity_dimension_spread gauge');
    for (const [dim, val] of Object.entries(diversity.perDimensionSpread)) {
      lines.push(`chrono_persona_diversity_dimension_spread{dimension="${dim}"} ${Math.round(val * 10_000) / 10_000}`);
    }
    lines.push('# HELP chrono_ws_connections_active 活跃 WebSocket 连接数');
    lines.push('# TYPE chrono_ws_connections_active gauge');
    lines.push(`chrono_ws_connections_active ${getWsConnectionCount()}`);
    lines.push('# HELP chrono_billing_meter_events_total Stripe 计量事件统计');
    lines.push('# TYPE chrono_billing_meter_events_total counter');
    lines.push(`chrono_billing_meter_events_total{status="enqueued"} ${billingMetrics.meterEventsEnqueued}`);
    lines.push(`chrono_billing_meter_events_total{status="processed"} ${billingMetrics.meterEventsProcessed}`);
    lines.push(`chrono_billing_meter_events_total{status="failed"} ${billingMetrics.meterEventsFailed}`);

    const outbox = health.take(metricsService.getBillingOutboxBacklog());
    lines.push('# HELP chrono_billing_outbox_backlog 计量发件箱积压');
    lines.push('# TYPE chrono_billing_outbox_backlog gauge');
    lines.push(`chrono_billing_outbox_backlog{status="pending"} ${outbox.pending}`);
    lines.push(`chrono_billing_outbox_backlog{status="failed"} ${outbox.failed}`);
    /* 感知媒体 retention fan-out（GDPR Art.17）：坏 shard 擦除失败计数（可告警）+ 降级 gauge。 */
    lines.push('# HELP chrono_media_retention_shard_erase_failures_total 媒体 retention shard 擦除失败累计（坏 shard 或 failed>0）');
    lines.push('# TYPE chrono_media_retention_shard_erase_failures_total counter');
    lines.push(`chrono_media_retention_shard_erase_failures_total ${mediaRetentionMetrics.shardEraseFailures}`);
    lines.push('# HELP chrono_media_retention_degraded 媒体 retention 降级状态（0=健康，1=有 shard 连续失败）');
    lines.push('# TYPE chrono_media_retention_degraded gauge');
    lines.push(`chrono_media_retention_degraded ${mediaRetentionMetrics.degraded}`);
    lines.push('# HELP chrono_observability_events_total 异步观测事件处理统计');
    lines.push('# TYPE chrono_observability_events_total counter');
    lines.push(`chrono_observability_events_total{status="enqueued"} ${observabilityPipelineMetrics.eventsEnqueued}`);
    lines.push(`chrono_observability_events_total{status="processed"} ${observabilityPipelineMetrics.eventsProcessed}`);
    lines.push(`chrono_observability_events_total{status="failed"} ${observabilityPipelineMetrics.eventsFailed}`);
    lines.push(`chrono_observability_events_total{status="recovered"} ${observabilityPipelineMetrics.eventsRecovered}`);
    lines.push('# HELP chrono_observability_outbox_backlog 异步观测发件箱积压');
    lines.push('# TYPE chrono_observability_outbox_backlog gauge');
    lines.push(`chrono_observability_outbox_backlog{status="pending"} ${observability.backlog.pending}`);
    lines.push(`chrono_observability_outbox_backlog{status="processing"} ${observability.backlog.processing}`);
    lines.push(`chrono_observability_outbox_backlog{status="failed"} ${observability.backlog.failed}`);
    lines.push('# HELP chrono_runtime_completed_total 完成的 runtime 会话数');
    lines.push('# TYPE chrono_runtime_completed_total counter');
    lines.push(`chrono_runtime_completed_total ${observability.rollup.runtime_completed_count}`);
    lines.push('# HELP chrono_runtime_duration_ms_avg runtime 平均耗时');
    lines.push('# TYPE chrono_runtime_duration_ms_avg gauge');
    lines.push(`chrono_runtime_duration_ms_avg ${runtimeAvgDuration}`);
    lines.push('# HELP chrono_task_terminal_total 已终态任务数');
    lines.push('# TYPE chrono_task_terminal_total counter');
    lines.push(`chrono_task_terminal_total ${observability.rollup.task_terminal_count}`);
    lines.push('# HELP chrono_task_success_total 成功任务数');
    lines.push('# TYPE chrono_task_success_total counter');
    lines.push(`chrono_task_success_total ${observability.rollup.task_success_count}`);
    lines.push('# HELP chrono_task_success_rate 任务成功率');
    lines.push('# TYPE chrono_task_success_rate gauge');
    lines.push(`chrono_task_success_rate ${taskSuccessRate}`);
    lines.push('# HELP chrono_wallet_settlement_total 钱包结算次数');
    lines.push('# TYPE chrono_wallet_settlement_total counter');
    lines.push(`chrono_wallet_settlement_total ${observability.rollup.wallet_settlement_count}`);
    lines.push('# HELP chrono_wallet_settlement_latency_ms_avg 钱包结算平均延迟');
    lines.push('# TYPE chrono_wallet_settlement_latency_ms_avg gauge');
    lines.push(`chrono_wallet_settlement_latency_ms_avg ${walletSettlementLatency}`);
    lines.push('# HELP chrono_wallet_settlement_amount_minor_total 钱包结算总额（minor）');
    lines.push('# TYPE chrono_wallet_settlement_amount_minor_total counter');
    lines.push(`chrono_wallet_settlement_amount_minor_total ${observability.rollup.wallet_settlement_total_amount_minor}`);
    lines.push('# HELP chrono_governance_cases_active 当前活跃治理案件数');
    lines.push('# TYPE chrono_governance_cases_active gauge');
    lines.push(`chrono_governance_cases_active ${observability.rollup.governance_case_active_count}`);
    lines.push('# HELP chrono_governance_case_events_total 治理事件累计数');
    lines.push('# TYPE chrono_governance_case_events_total counter');
    lines.push(`chrono_governance_case_events_total{type="opened"} ${observability.rollup.governance_case_opened_count}`);
    lines.push(`chrono_governance_case_events_total{type="action_applied"} ${observability.rollup.governance_action_applied_count}`);
    lines.push('# HELP chrono_persona_growth_total 人格成长累计增量');
    lines.push('# TYPE chrono_persona_growth_total counter');
    lines.push(`chrono_persona_growth_total ${observability.rollup.persona_growth_total}`);
    lines.push('# HELP chrono_persona_growth_events_total 人格成长事件数');
    lines.push('# TYPE chrono_persona_growth_events_total counter');
    lines.push(`chrono_persona_growth_events_total ${observability.rollup.persona_growth_event_count}`);
    lines.push('# HELP chrono_persona_growth_delta_avg 人格平均成长增量');
    lines.push('# TYPE chrono_persona_growth_delta_avg gauge');
    lines.push(`chrono_persona_growth_delta_avg ${personaGrowthAvg}`);

    const chatLatency = llmLatencyPercentiles(llmMetrics.chatLatencyMs);
    const embedLatency = llmLatencyPercentiles(llmMetrics.embedLatencyMs);
    lines.push('# HELP chrono_llm_calls_total LLM 调用总数');
    lines.push('# TYPE chrono_llm_calls_total counter');
    lines.push(`chrono_llm_calls_total{method="chat"} ${llmMetrics.chatCalls}`);
    lines.push(`chrono_llm_calls_total{method="embed"} ${llmMetrics.embedCalls}`);
    lines.push('# HELP chrono_llm_errors_total LLM 调用错误数');
    lines.push('# TYPE chrono_llm_errors_total counter');
    lines.push(`chrono_llm_errors_total{method="chat"} ${llmMetrics.chatErrors}`);
    lines.push(`chrono_llm_errors_total{method="embed"} ${llmMetrics.embedErrors}`);
    lines.push('# HELP chrono_llm_latency_ms LLM 调用延迟百分位');
    lines.push('# TYPE chrono_llm_latency_ms summary');
    lines.push(`chrono_llm_latency_ms{method="chat",quantile="0.5"} ${chatLatency.p50}`);
    lines.push(`chrono_llm_latency_ms{method="chat",quantile="0.9"} ${chatLatency.p90}`);
    lines.push(`chrono_llm_latency_ms{method="chat",quantile="0.99"} ${chatLatency.p99}`);
    lines.push(`chrono_llm_latency_ms{method="embed",quantile="0.5"} ${embedLatency.p50}`);
    lines.push(`chrono_llm_latency_ms{method="embed",quantile="0.9"} ${embedLatency.p90}`);
    lines.push(`chrono_llm_latency_ms{method="embed",quantile="0.99"} ${embedLatency.p99}`);
    lines.push('# HELP chrono_llm_tokens_consumed_total LLM token 消耗总量');
    lines.push('# TYPE chrono_llm_tokens_consumed_total counter');
    lines.push(`chrono_llm_tokens_consumed_total ${llmMetrics.totalTokensConsumed}`);
    lines.push('# HELP chrono_llm_fallbacks_total LLM provider 降级次数（ADR-0047 D2，主不可用→下一档）');
    lines.push('# TYPE chrono_llm_fallbacks_total counter');
    lines.push(`chrono_llm_fallbacks_total ${llmMetrics.fallbacks}`);

    const queueBacklog = health.take(metricsService.getQueueBacklog());
    lines.push('# HELP chrono_queue_backlog 任务队列积压');
    lines.push('# TYPE chrono_queue_backlog gauge');
    lines.push(`chrono_queue_backlog{status="pending"} ${queueBacklog.pending}`);
    lines.push(`chrono_queue_backlog{status="running"} ${queueBacklog.running}`);
    lines.push(`chrono_queue_backlog{status="failed"} ${queueBacklog.failed}`);

    const tenantUsage = health.take(metricsService.getTenantUsage(retentionMs));
    if (tenantUsage.length > 0) {
      const retentionDays = Math.round(retentionMs / (24 * 60 * 60 * 1000));
      lines.push(`# HELP chrono_tenant_usage 每租户资源使用量（最近${retentionDays}天）`);
      lines.push('# TYPE chrono_tenant_usage gauge');
      for (const row of tenantUsage) {
        lines.push(`chrono_tenant_usage{tenant="${row.tenant_id}",resource="${row.resource}"} ${row.total}`);
      }
    }

    /* 跨 shard scatter-gather 健康（Plan 2 · Task 5）：degraded gauge（0=全 shard 健康，1=有 shard 失败=部分
     * 聚合）+ shard 失败数 counter。运维据此告警「本次 metrics 是降级值，勿据其做容量决策」——非静默当零。 */
    lines.push('# HELP chrono_metrics_shard_degraded 跨租户指标聚合降级状态（0=全 shard 健康，1=有 shard 失败=部分聚合）');
    lines.push('# TYPE chrono_metrics_shard_degraded gauge');
    lines.push(`chrono_metrics_shard_degraded ${health.degraded ? 1 : 0}`);
    lines.push('# HELP chrono_metrics_shard_failures 本次 scrape 中聚合失败的 shard 数（去重）');
    lines.push('# TYPE chrono_metrics_shard_failures gauge');
    lines.push(`chrono_metrics_shard_failures ${health.failureCount}`);

    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(lines.join('\n') + '\n');
  });
}
