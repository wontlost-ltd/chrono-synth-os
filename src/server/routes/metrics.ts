/**
 * 指标端点
 * GET /metrics — JSON 格式运行时指标
 * GET /metrics/prometheus — Prometheus text exposition 格式
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { getMetricsSnapshot, getTotalRequests } from '../plugins/metrics.js';
import { getWsConnectionCount } from '../plugins/websocket.js';
import { billingMetrics } from '../../billing/billing-outbox.js';
import { llmMetrics } from '../../intelligence/model-router.js';
import { calculatePercentile } from '../plugins/metrics.js';

function llmLatencyPercentiles(arr: number[]): { p50: number; p90: number; p99: number } {
  if (arr.length === 0) return { p50: 0, p90: 0, p99: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    p50: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
    p90: Math.round(calculatePercentile(sorted, 90) * 100) / 100,
    p99: Math.round(calculatePercentile(sorted, 99) * 100) / 100,
  };
}

function getQueueBacklog(os: ChronoSynthOS): { pending: number; running: number; failed: number } {
  try {
    const db = os.getDatabase();
    const pending = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'`).get()?.count ?? 0;
    const running = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM tasks WHERE status = 'running'`).get()?.count ?? 0;
    const failed = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM tasks WHERE status = 'failed'`).get()?.count ?? 0;
    return { pending, running, failed };
  } catch { return { pending: 0, running: 0, failed: 0 }; }
}

const startTime = Date.now();

export function registerMetricsRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  app.get('/metrics', async () => {
    const mem = process.memoryUsage();
    let outboxPending = 0;
    let outboxFailed = 0;
    try {
      const db = os.getDatabase();
      outboxPending = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'pending'`).get()?.count ?? 0;
      outboxFailed = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'failed'`).get()?.count ?? 0;
    } catch { /* 发件箱表可能尚未创建 */ }
    return {
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      requests: {
        total: getTotalRequests(),
        by_endpoint: getMetricsSnapshot(),
      },
      business: {
        persona_count: os.accelerated.getAllPersonas().length,
        conflict_count: os.meta.conflicts.getUnresolved().length,
        snapshot_count: os.snapshots.list().length,
      },
      billing: {
        meter_events_enqueued: billingMetrics.meterEventsEnqueued,
        meter_events_processed: billingMetrics.meterEventsProcessed,
        meter_events_failed: billingMetrics.meterEventsFailed,
        outbox_pending: outboxPending,
        outbox_failed: outboxFailed,
      },
      llm: {
        chat_calls: llmMetrics.chatCalls,
        chat_errors: llmMetrics.chatErrors,
        chat_latency_ms: llmLatencyPercentiles(llmMetrics.chatLatencyMs),
        embed_calls: llmMetrics.embedCalls,
        embed_errors: llmMetrics.embedErrors,
        embed_latency_ms: llmLatencyPercentiles(llmMetrics.embedLatencyMs),
        total_tokens_consumed: llmMetrics.totalTokensConsumed,
      },
      queue: getQueueBacklog(os),
      system: {
        memory_mb: {
          rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        },
        ws_connections_active: getWsConnectionCount(),
      },
    };
  });

  /** Prometheus text exposition 格式 */
  app.get('/metrics/prometheus', async (_request, reply) => {
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const snapshot = getMetricsSnapshot();
    const totalRequests = getTotalRequests();
    const personaCount = os.accelerated.getAllPersonas().length;
    const conflictCount = os.meta.conflicts.getUnresolved().length;
    const snapshotCount = os.snapshots.list().length;

    const lines: string[] = [];

    /* 系统 */
    lines.push('# HELP chrono_uptime_seconds 服务运行时间（秒）');
    lines.push('# TYPE chrono_uptime_seconds gauge');
    lines.push(`chrono_uptime_seconds ${uptimeSeconds}`);

    lines.push('# HELP chrono_process_memory_bytes 进程内存使用');
    lines.push('# TYPE chrono_process_memory_bytes gauge');
    lines.push(`chrono_process_memory_bytes{type="rss"} ${mem.rss}`);
    lines.push(`chrono_process_memory_bytes{type="heap_used"} ${mem.heapUsed}`);
    lines.push(`chrono_process_memory_bytes{type="heap_total"} ${mem.heapTotal}`);

    /* 请求 */
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

    /* 业务 */
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

    /* 计费 */
    lines.push('# HELP chrono_billing_meter_events_total Stripe 计量事件统计');
    lines.push('# TYPE chrono_billing_meter_events_total counter');
    lines.push(`chrono_billing_meter_events_total{status="enqueued"} ${billingMetrics.meterEventsEnqueued}`);
    lines.push(`chrono_billing_meter_events_total{status="processed"} ${billingMetrics.meterEventsProcessed}`);
    lines.push(`chrono_billing_meter_events_total{status="failed"} ${billingMetrics.meterEventsFailed}`);

    let outboxPendingProm = 0;
    let outboxFailedProm = 0;
    try {
      const db = os.getDatabase();
      outboxPendingProm = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'pending'`).get()?.count ?? 0;
      outboxFailedProm = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM billing_outbox WHERE status = 'failed'`).get()?.count ?? 0;
    } catch { /* 发件箱表可能尚未创建 */ }
    lines.push('# HELP chrono_billing_outbox_backlog 计量发件箱积压');
    lines.push('# TYPE chrono_billing_outbox_backlog gauge');
    lines.push(`chrono_billing_outbox_backlog{status="pending"} ${outboxPendingProm}`);
    lines.push(`chrono_billing_outbox_backlog{status="failed"} ${outboxFailedProm}`);

    /* LLM */
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

    /* 任务队列 */
    const queueBacklog = getQueueBacklog(os);
    lines.push('# HELP chrono_queue_backlog 任务队列积压');
    lines.push('# TYPE chrono_queue_backlog gauge');
    lines.push(`chrono_queue_backlog{status="pending"} ${queueBacklog.pending}`);
    lines.push(`chrono_queue_backlog{status="running"} ${queueBacklog.running}`);
    lines.push(`chrono_queue_backlog{status="failed"} ${queueBacklog.failed}`);

    /* 每租户使用量（最近 24 小时，限制最多 200 条避免基数爆炸） */
    try {
      const db = os.getDatabase();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const tenantUsage = db.prepare<{ tenant_id: string; resource: string; total: number }>(
        `SELECT tenant_id, resource, SUM(quantity) as total FROM usage_records WHERE recorded_at > ? GROUP BY tenant_id, resource ORDER BY total DESC LIMIT 200`,
      ).all(cutoff);
      if (tenantUsage.length > 0) {
        lines.push('# HELP chrono_tenant_usage_24h 每租户资源使用量（最近24小时）');
        lines.push('# TYPE chrono_tenant_usage_24h gauge');
        for (const row of tenantUsage) {
          lines.push(`chrono_tenant_usage_24h{tenant="${row.tenant_id}",resource="${row.resource}"} ${row.total}`);
        }
      }
    } catch { /* usage_records 表可能尚未创建 */ }

    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(lines.join('\n') + '\n');
  });
}
