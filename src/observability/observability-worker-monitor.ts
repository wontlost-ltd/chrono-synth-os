import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getObservabilityOutboxBacklog, type ObservabilityOutboxBacklog } from './observability-outbox.js';
import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { getPackageVersion } from '../utils/package-version.js';

const LAYER = 'ObservabilityWorkerMonitor';

export interface ObservabilityWorkerRuntime {
  readonly activeMode: 'stopped' | 'direct' | 'kafka';
  readonly inflight: number;
  isHealthy(): boolean;
}

export interface ObservabilityWorkerMonitorOptions {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ObservabilityWorkerMonitorDeps {
  db: IDatabase;
  pipeline: ObservabilityWorkerRuntime;
  logger: Logger;
  version?: string;
  startTime?: number;
}

export interface ObservabilityWorkerMonitorSnapshot {
  status: 'ok' | 'degraded' | 'shutting_down';
  version: string;
  uptime: number;
  ready: boolean;
  components: {
    pipeline: {
      status: 'ok' | 'stopped';
      mode: 'stopped' | 'direct' | 'kafka';
      inflight: number;
    };
    database: {
      status: 'ok' | 'degraded';
      error?: string;
    };
    outbox: {
      status: 'ok' | 'unavailable';
      backlog: ObservabilityOutboxBacklog;
    };
  };
}

const EMPTY_BACKLOG: ObservabilityOutboxBacklog = Object.freeze({
  pending: 0,
  processing: 0,
  failed: 0,
});

export interface BuildObservabilityWorkerMonitorSnapshotOptions {
  now?: number;
  shuttingDown?: boolean;
}

export function buildObservabilityWorkerMonitorSnapshot(
  deps: ObservabilityWorkerMonitorDeps,
  options: BuildObservabilityWorkerMonitorSnapshotOptions = {},
): ObservabilityWorkerMonitorSnapshot {
  const now = options.now ?? Date.now();
  const startTime = deps.startTime ?? now;
  const pipelineHealthy = deps.pipeline.isHealthy();
  const pipelineStatus: 'ok' | 'stopped' = pipelineHealthy ? 'ok' : 'stopped';

  let databaseStatus: 'ok' | 'degraded' = 'ok';
  let databaseError: string | undefined;
  let backlog = EMPTY_BACKLOG;
  let outboxStatus: 'ok' | 'unavailable' = 'ok';

  try {
    deps.db.prepare<{ ok: number }>('SELECT 1 AS ok').get();
    backlog = getObservabilityOutboxBacklog(deps.db);
  } catch (err) {
    databaseStatus = 'degraded';
    outboxStatus = 'unavailable';
    databaseError = err instanceof Error ? err.message : String(err);
  }

  const shuttingDown = options.shuttingDown === true;
  const ready = !shuttingDown && pipelineHealthy && databaseStatus === 'ok';

  return {
    status: shuttingDown ? 'shutting_down' : (ready ? 'ok' : 'degraded'),
    version: deps.version ?? getPackageVersion(),
    uptime: Math.max(0, Math.floor((now - startTime) / 1000)),
    ready,
    components: {
      pipeline: {
        status: pipelineStatus,
        mode: deps.pipeline.activeMode,
        inflight: deps.pipeline.inflight,
      },
      database: {
        status: databaseStatus,
        ...(databaseError ? { error: databaseError } : {}),
      },
      outbox: {
        status: outboxStatus,
        backlog,
      },
    },
  };
}

export function renderObservabilityWorkerPrometheusMetrics(snapshot: ObservabilityWorkerMonitorSnapshot): string {
  const currentMode = snapshot.components.pipeline.mode;
  const lines = [
    '# HELP chrono_observability_worker_up Dedicated observability worker process health.',
    '# TYPE chrono_observability_worker_up gauge',
    'chrono_observability_worker_up 1',
    '# HELP chrono_observability_worker_ready Dedicated observability worker readiness state.',
    '# TYPE chrono_observability_worker_ready gauge',
    `chrono_observability_worker_ready ${snapshot.ready ? 1 : 0}`,
    '# HELP chrono_observability_worker_uptime_seconds Dedicated observability worker uptime in seconds.',
    '# TYPE chrono_observability_worker_uptime_seconds gauge',
    `chrono_observability_worker_uptime_seconds ${snapshot.uptime}`,
    '# HELP chrono_observability_worker_inflight_jobs Dedicated observability worker in-flight jobs.',
    '# TYPE chrono_observability_worker_inflight_jobs gauge',
    `chrono_observability_worker_inflight_jobs ${snapshot.components.pipeline.inflight}`,
    '# HELP chrono_observability_worker_db_ready Dedicated observability worker database connectivity.',
    '# TYPE chrono_observability_worker_db_ready gauge',
    `chrono_observability_worker_db_ready ${snapshot.components.database.status === 'ok' ? 1 : 0}`,
    '# HELP chrono_observability_worker_outbox_pending Pending observability outbox events.',
    '# TYPE chrono_observability_worker_outbox_pending gauge',
    `chrono_observability_worker_outbox_pending ${snapshot.components.outbox.backlog.pending}`,
    '# HELP chrono_observability_worker_outbox_processing Processing observability outbox events.',
    '# TYPE chrono_observability_worker_outbox_processing gauge',
    `chrono_observability_worker_outbox_processing ${snapshot.components.outbox.backlog.processing}`,
    '# HELP chrono_observability_worker_outbox_failed Failed observability outbox events.',
    '# TYPE chrono_observability_worker_outbox_failed gauge',
    `chrono_observability_worker_outbox_failed ${snapshot.components.outbox.backlog.failed}`,
    '# HELP chrono_observability_worker_mode Worker mode gauge with one-hot labels.',
    '# TYPE chrono_observability_worker_mode gauge',
    `chrono_observability_worker_mode{mode="direct"} ${currentMode === 'direct' ? 1 : 0}`,
    `chrono_observability_worker_mode{mode="kafka"} ${currentMode === 'kafka' ? 1 : 0}`,
    `chrono_observability_worker_mode{mode="stopped"} ${currentMode === 'stopped' ? 1 : 0}`,
  ];
  return `${lines.join('\n')}\n`;
}

export class ObservabilityWorkerMonitorServer {
  private server: HttpServer | undefined;
  private shuttingDown = false;

  constructor(
    private readonly deps: ObservabilityWorkerMonitorDeps,
    private readonly options: ObservabilityWorkerMonitorOptions,
  ) {}

  get isEnabled(): boolean {
    return this.options.enabled;
  }

  get address(): string | undefined {
    if (!this.server) return undefined;
    const address = this.server.address();
    if (!address || typeof address === 'string') return undefined;
    return `http://${this.options.host}:${address.port}`;
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  snapshot(now?: number): ObservabilityWorkerMonitorSnapshot {
    return buildObservabilityWorkerMonitorSnapshot(this.deps, {
      now,
      shuttingDown: this.shuttingDown,
    });
  }

  async start(): Promise<void> {
    if (!this.options.enabled || this.server) return;

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on('error', (err) => {
      this.deps.logger.error(LAYER, 'worker monitor 服务异常', err);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.options.port, this.options.host, () => resolve());
      this.server!.once('error', reject);
    }).finally(() => {
      this.server?.removeAllListeners('error');
      this.server?.on('error', (err) => {
        this.deps.logger.error(LAYER, 'worker monitor 服务异常', err);
      });
    });

    const boundAddress = this.server.address();
    const port = typeof boundAddress === 'object' && boundAddress ? (boundAddress as AddressInfo).port : this.options.port;
    this.deps.logger.info(LAYER, `worker monitor 已启动（${this.options.host}:${port}）`);
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (!this.server) return;

    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.deps.logger.info(LAYER, 'worker monitor 已关闭');
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (method !== 'GET' && method !== 'HEAD') {
      this.writePlainText(response, 405, 'method not allowed\n');
      return;
    }

    const snapshot = this.snapshot();
    if (path === '/healthz') {
      this.writeJson(response, 200, {
        status: snapshot.status === 'shutting_down' ? 'shutting_down' : 'ok',
        version: snapshot.version,
        uptime: snapshot.uptime,
        mode: snapshot.components.pipeline.mode,
      }, method === 'HEAD');
      return;
    }

    if (path === '/readyz') {
      this.writeJson(response, snapshot.ready ? 200 : 503, snapshot, method === 'HEAD');
      return;
    }

    if (path === '/metrics' || path === '/metrics/prometheus') {
      this.writePlainText(
        response,
        200,
        renderObservabilityWorkerPrometheusMetrics(snapshot),
        method === 'HEAD',
        'text/plain; version=0.0.4; charset=utf-8',
      );
      return;
    }

    this.writeJson(response, 404, { error: 'not_found' }, method === 'HEAD');
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: unknown, headOnly = false): void {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.byteLength,
      'cache-control': 'no-store',
    });
    if (!headOnly) {
      response.end(body);
      return;
    }
    response.end();
  }

  private writePlainText(
    response: ServerResponse,
    statusCode: number,
    body: string,
    headOnly = false,
    contentType = 'text/plain; charset=utf-8',
  ): void {
    response.writeHead(statusCode, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    if (!headOnly) {
      response.end(body);
      return;
    }
    response.end();
  }
}
