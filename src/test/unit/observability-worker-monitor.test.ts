import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
import { SilentLogger } from '../../utils/logger.js';
import { OBSERVABILITY_TOPIC, publishObservabilityEvent } from '../../observability/observability-outbox.js';
import {
  ObservabilityWorkerMonitorServer,
  buildObservabilityWorkerMonitorSnapshot,
  renderObservabilityWorkerPrometheusMetrics,
} from '../../observability/observability-worker-monitor.js';

describe('ObservabilityWorkerMonitor', () => {
  let db: IDatabase;
  let logger: SilentLogger;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    logger = new SilentLogger();
  });

  it('输出 ready snapshot 和 Prometheus 指标', () => {
    publishObservabilityEvent(directUnitOfWork(db), {
      tenantId: 'tenant_monitor',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_1',
      payload: { durationMs: 1200 },
    });

    const snapshot = buildObservabilityWorkerMonitorSnapshot({
      db,
      logger,
      startTime: 1_000,
      version: '2.0.0-test',
      pipeline: {
        activeMode: 'direct',
        inflight: 2,
        isHealthy: () => true,
      },
    }, {
      now: 11_000,
    });

    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.version, '2.0.0-test');
    assert.equal(snapshot.uptime, 10);
    assert.equal(snapshot.components.pipeline.mode, 'direct');
    assert.equal(snapshot.components.pipeline.inflight, 2);
    assert.equal(snapshot.components.outbox.backlog.pending, 1);
    assert.equal(snapshot.components.outbox.backlog.processing, 0);
    assert.equal(snapshot.components.outbox.backlog.failed, 0);

    const metrics = renderObservabilityWorkerPrometheusMetrics(snapshot);
    assert.match(metrics, /chrono_observability_worker_ready 1/);
    assert.match(metrics, /chrono_observability_worker_inflight_jobs 2/);
    assert.match(metrics, /chrono_observability_worker_outbox_pending 1/);
    assert.match(metrics, /chrono_observability_worker_mode\{mode="direct"\} 1/);
  });

  it('数据库不可达时返回 degraded', () => {
    const brokenDb = {
      exec() {},
      close() {},
      transaction<T>(fn: () => T): T {
        return fn();
      },
      prepare() {
        throw new Error('db offline');
      },
    } as unknown as IDatabase;

    const snapshot = buildObservabilityWorkerMonitorSnapshot({
      db: brokenDb,
      logger,
      pipeline: {
        activeMode: 'kafka',
        inflight: 0,
        isHealthy: () => true,
      },
    });

    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.components.database.status, 'degraded');
    assert.equal(snapshot.components.outbox.status, 'unavailable');
    assert.match(snapshot.components.database.error ?? '', /db offline/);
  });

  it('shutting down 时 readyz 应降级', () => {
    const snapshot = buildObservabilityWorkerMonitorSnapshot({
      db,
      logger,
      pipeline: {
        activeMode: 'direct',
        inflight: 0,
        isHealthy: () => true,
      },
    }, {
      shuttingDown: true,
    });

    assert.equal(snapshot.status, 'shutting_down');
    assert.equal(snapshot.ready, false);
  });

  it('monitor server 同时暴露 /metrics 与 /metrics/prometheus', async () => {
    const server = new ObservabilityWorkerMonitorServer({
      db,
      logger,
      startTime: 1_000,
      version: '2.0.0-test',
      pipeline: {
        activeMode: 'kafka',
        inflight: 0,
        isHealthy: () => true,
      },
    }, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
    });

    const metrics = await invokeMonitor(server, '/metrics');
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.body, /chrono_observability_worker_mode\{mode="kafka"\} 1/);

    const prometheus = await invokeMonitor(server, '/metrics/prometheus');
    assert.equal(prometheus.statusCode, 200);
    assert.match(prometheus.body, /chrono_observability_worker_ready 1/);
  });
});

async function invokeMonitor(
  server: ObservabilityWorkerMonitorServer,
  path: string,
): Promise<{ statusCode: number; body: string; headers: Record<string, string | number | string[]> }> {
  let statusCode = 0;
  let headers: Record<string, string | number | string[]> = {};
  const chunks: Buffer[] = [];

  const response = {
    writeHead(code: number, nextHeaders: Record<string, string | number | string[]>) {
      statusCode = code;
      headers = nextHeaders;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      }
      return this;
    },
  } as unknown as ServerResponse;

  const request = {
    method: 'GET',
    url: path,
  } as IncomingMessage;

  await (
    server as unknown as {
      handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
    }
  ).handleRequest(request, response);

  return {
    statusCode,
    body: Buffer.concat(chunks).toString('utf8'),
    headers,
  };
}
