import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { recordPlatformDlqEvent } from '../events/platform-dlq.js';
import {
  getObservabilityOutboxBacklog,
  listPendingObservabilityEvents,
  markObservabilityEventFailed,
  markObservabilityEventProcessing,
  markObservabilityEventSent,
  requeueStaleObservabilityEvents,
  type ObservabilityOutboxBacklog,
  type ObservabilityOutboxRow,
} from './observability-outbox.js';
import { applyObservabilityStoredEvent } from './observability-rollups.js';

const LAYER = 'ObservabilityWorker';

export interface ObservabilityWorkerOptions {
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  staleProcessingMs: number;
}

export interface ObservabilityFlushResult {
  processed: number;
  failed: number;
  recovered: number;
  backlog: ObservabilityOutboxBacklog;
}

const DEFAULT_OPTIONS: ObservabilityWorkerOptions = {
  pollIntervalMs: 1000,
  batchSize: 100,
  maxAttempts: 5,
  staleProcessingMs: 5 * 60 * 1000,
};

export class ObservabilityWorker {
  private readonly options: ObservabilityWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentRun: Promise<ObservabilityFlushResult> | undefined;

  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
    options: Partial<ObservabilityWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.error(LAYER, '观测事件处理失败', err);
      });
    }, this.options.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info(LAYER, `工作者已启动（间隔=${this.options.pollIntervalMs}ms, 批次=${this.options.batchSize}）`);
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  get inflight(): number {
    return this.currentRun ? 1 : 0;
  }

  async stop(drainTimeoutMs = 10_000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (!this.currentRun) {
      this.logger.info(LAYER, '工作者已停止');
      return;
    }

    const deadline = Date.now() + drainTimeoutMs;
    while (Date.now() < deadline) {
      const run = this.currentRun;
      if (!run) break;
      await run.catch(() => undefined);
    }
    const stillRunning = this.currentRun !== undefined;
    if (stillRunning) {
      this.logger.warn(LAYER, '工作者排空超时');
    }
    this.logger.info(LAYER, '工作者已停止');
  }

  flush(batchSize = this.options.batchSize): Promise<ObservabilityFlushResult> {
    if (this.currentRun) return this.currentRun;
    const run = Promise.resolve(this.flushInternal(batchSize)).finally(() => {
      if (this.currentRun === run) {
        this.currentRun = undefined;
      }
    });
    this.currentRun = run;
    return run;
  }

  private flushInternal(batchSize: number): ObservabilityFlushResult {
    const tx = this.db;
    const recovered = requeueStaleObservabilityEvents(tx, Date.now() - this.options.staleProcessingMs);
    const rows = listPendingObservabilityEvents(tx, batchSize);

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      if (!markObservabilityEventProcessing(tx, row.id)) continue;

      try {
        this.db.transaction(() => {
          applyEventToRollups(this.db, row);
          markObservabilityEventSent(tx, row.id);
        });
        processed++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        markObservabilityEventFailed(tx, row, message, this.options.maxAttempts);
        if (row.attempts + 1 >= this.options.maxAttempts) {
          recordPlatformDlqEvent(this.db, {
            tenantId: row.tenant_id,
            sourceComponent: 'observability_worker',
            sourceTopic: row.topic,
            eventType: row.event_type,
            partitionKey: row.partition_key,
            payload: parseDlqPayload(row.payload_json),
            errorMessage: message,
          });
        }
        this.logger.warn(LAYER, `观测事件处理失败: ${row.id}`, { eventType: row.event_type, error: message });
      }
    }

    return {
      processed,
      failed,
      recovered,
      backlog: getObservabilityOutboxBacklog(tx),
    };
  }
}

function applyEventToRollups(db: IDatabase, row: ObservabilityOutboxRow): void {
  const payload = parsePayload(row.payload_json);
  applyObservabilityStoredEvent(db, {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    payload,
    createdAt: row.created_at,
  });
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  const parsed = JSON.parse(payloadJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('observability payload 必须是对象');
  }
  return parsed as Record<string, unknown>;
}

function parseDlqPayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}
