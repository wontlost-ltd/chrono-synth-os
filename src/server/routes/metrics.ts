/**
 * 指标端点
 * GET /metrics — JSON 格式运行时指标
 * GET /metrics/prometheus — Prometheus text exposition 格式
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import { getMetricsSnapshot, getTotalRequests } from '../plugins/metrics.js';
import { getWsConnectionCount } from '../plugins/websocket.js';
import { billingMetrics } from '../../billing/billing-outbox.js';
import { llmMetrics } from '../../intelligence/model-router.js';
import { safetyMetrics } from '../../intelligence/llm-safety.js';
import { calculatePercentile } from '../plugins/metrics.js';
import { observabilityPipelineMetrics } from '../../observability/observability-outbox.js';
import { MetricsQueryService } from '../../observability/metrics-query-service.js';

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

export function registerMetricsRoutes(app: FastifyInstance, os: ChronoSynthOS, config?: AppConfig): void {
  const retentionMs = config?.observability.metricsRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const metricsService = new MetricsQueryService(os.getDatabase());

  app.get('/metrics', async () => {
    const mem = process.memoryUsage();
    const outbox = metricsService.getBillingOutboxBacklog();
    const observability = metricsService.getObservabilitySummary();
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
      },
      billing: {
        meter_events_enqueued: billingMetrics.meterEventsEnqueued,
        meter_events_processed: billingMetrics.meterEventsProcessed,
        meter_events_failed: billingMetrics.meterEventsFailed,
        outbox_pending: outbox.pending,
        outbox_failed: outbox.failed,
      },
      llm: {
        chat_calls: llmMetrics.chatCalls,
        chat_errors: llmMetrics.chatErrors,
        chat_latency_ms: llmLatencyPercentiles(llmMetrics.chatLatencyMs),
        embed_calls: llmMetrics.embedCalls,
        embed_errors: llmMetrics.embedErrors,
        embed_latency_ms: llmLatencyPercentiles(llmMetrics.embedLatencyMs),
        total_tokens_consumed: llmMetrics.totalTokensConsumed,
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
      queue: metricsService.getQueueBacklog(),
      system: {
        memory_mb: {
          rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        },
        ws_connections_active: getWsConnectionCount(),
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
    const observability = metricsService.getObservabilitySummary();
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
    lines.push('# HELP chrono_ws_connections_active 活跃 WebSocket 连接数');
    lines.push('# TYPE chrono_ws_connections_active gauge');
    lines.push(`chrono_ws_connections_active ${getWsConnectionCount()}`);
    lines.push('# HELP chrono_billing_meter_events_total Stripe 计量事件统计');
    lines.push('# TYPE chrono_billing_meter_events_total counter');
    lines.push(`chrono_billing_meter_events_total{status="enqueued"} ${billingMetrics.meterEventsEnqueued}`);
    lines.push(`chrono_billing_meter_events_total{status="processed"} ${billingMetrics.meterEventsProcessed}`);
    lines.push(`chrono_billing_meter_events_total{status="failed"} ${billingMetrics.meterEventsFailed}`);

    const outbox = metricsService.getBillingOutboxBacklog();
    lines.push('# HELP chrono_billing_outbox_backlog 计量发件箱积压');
    lines.push('# TYPE chrono_billing_outbox_backlog gauge');
    lines.push(`chrono_billing_outbox_backlog{status="pending"} ${outbox.pending}`);
    lines.push(`chrono_billing_outbox_backlog{status="failed"} ${outbox.failed}`);
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

    const queueBacklog = metricsService.getQueueBacklog();
    lines.push('# HELP chrono_queue_backlog 任务队列积压');
    lines.push('# TYPE chrono_queue_backlog gauge');
    lines.push(`chrono_queue_backlog{status="pending"} ${queueBacklog.pending}`);
    lines.push(`chrono_queue_backlog{status="running"} ${queueBacklog.running}`);
    lines.push(`chrono_queue_backlog{status="failed"} ${queueBacklog.failed}`);

    const tenantUsage = metricsService.getTenantUsage(retentionMs);
    if (tenantUsage.length > 0) {
      const retentionDays = Math.round(retentionMs / (24 * 60 * 60 * 1000));
      lines.push(`# HELP chrono_tenant_usage 每租户资源使用量（最近${retentionDays}天）`);
      lines.push('# TYPE chrono_tenant_usage gauge');
      for (const row of tenantUsage) {
        lines.push(`chrono_tenant_usage{tenant="${row.tenant_id}",resource="${row.resource}"} ${row.total}`);
      }
    }

    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(lines.join('\n') + '\n');
  });
}
