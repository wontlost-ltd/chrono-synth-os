/**
 * 指标端点
 * GET /metrics — JSON 格式运行时指标
 * GET /metrics/prometheus — Prometheus text exposition 格式
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { getMetricsSnapshot, getTotalRequests } from '../plugins/metrics.js';
import { getWsConnectionCount } from '../plugins/websocket.js';

const startTime = Date.now();

export function registerMetricsRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  app.get('/metrics', async () => {
    const mem = process.memoryUsage();
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

    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(lines.join('\n') + '\n');
  });
}
