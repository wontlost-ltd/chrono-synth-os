import type { AppConfig } from '../config/schema.js';
import {
  buildTenantKafkaTopicPattern,
  resolveTenantKafkaTopic,
} from '../enterprise/tenant-kafka-topics.js';
import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
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
  type ObservabilityEventType,
} from './observability-outbox.js';
import { applyObservabilityStoredEvent } from './observability-rollups.js';

const LAYER = 'ObservabilityKafka';

export interface KafkaObservabilityMessage {
  id: string;
  tenantId: string;
  eventType: ObservabilityEventType;
  partitionKey: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

interface KafkaModuleLike {
  Kafka: new (options: Record<string, unknown>) => KafkaClientLike;
}

interface KafkaClientLike {
  producer(options?: Record<string, unknown>): KafkaProducerLike;
  consumer(options: Record<string, unknown>): KafkaConsumerLike;
}

interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(payload: {
    topic: string;
    messages: Array<{ key?: string; value: string; headers?: Record<string, string> }>;
    acks?: number;
    timeout?: number;
  }): Promise<unknown>;
}

interface KafkaConsumerLike {
  connect(): Promise<void>;
  subscribe(options: { topic: string | RegExp; fromBeginning?: boolean }): Promise<void>;
  run(options: {
    eachBatchAutoResolve?: boolean;
    eachBatch: (payload: {
      batch: { topic: string; messages: Array<{ key: Buffer | null; value: Buffer | null; offset: string }> };
      resolveOffset: (offset: string) => void;
      heartbeat: () => Promise<void>;
      commitOffsetsIfNecessary: () => Promise<void>;
      isRunning: () => boolean;
      isStale: () => boolean;
    }) => Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
}

export async function loadKafkaModule(): Promise<KafkaModuleLike | null> {
  const specifier = 'kafkajs';
  try {
    return await import(specifier) as unknown as KafkaModuleLike;
  } catch (err) {
    if (isModuleNotFoundError(err, specifier)) {
      return null;
    }
    throw err;
  }
}

export function outboxRowToKafkaMessage(row: ObservabilityOutboxRow): KafkaObservabilityMessage {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`观测事件 ${row.id} payload 不是对象`);
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    partitionKey: row.partition_key,
    payload: payload as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export function encodeKafkaObservabilityMessage(message: KafkaObservabilityMessage): {
  key: string;
  value: string;
  headers: Record<string, string>;
} {
  return {
    key: message.partitionKey,
    value: JSON.stringify(message),
    headers: {
      tenant_id: message.tenantId,
      event_type: message.eventType,
    },
  };
}

export function decodeKafkaObservabilityMessage(value: Buffer | string | null): KafkaObservabilityMessage {
  if (value === null) {
    throw new Error('Kafka 消息 value 不能为空');
  }
  const raw = typeof value === 'string' ? value : value.toString('utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Kafka 观测消息格式无效');
  }
  const message = parsed as Partial<KafkaObservabilityMessage>;
  if (
    typeof message.id !== 'string' ||
    typeof message.tenantId !== 'string' ||
    typeof message.eventType !== 'string' ||
    typeof message.partitionKey !== 'string' ||
    typeof message.createdAt !== 'number' ||
    !message.payload ||
    typeof message.payload !== 'object' ||
    Array.isArray(message.payload)
  ) {
    throw new Error('Kafka 观测消息缺少必要字段');
  }
  return message as KafkaObservabilityMessage;
}

export class ObservabilityKafkaOutboxProducer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentRun: Promise<ObservabilityKafkaFlushResult> | undefined;
  private producer: KafkaProducerLike | undefined;
  private started = false;
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
    private readonly config: AppConfig['observability'],
  ) {
    this.tx = db;
  }

  async start(): Promise<boolean> {
    if (this.started) return true;
    const producer = await createKafkaProducer(this.config, this.logger);
    if (!producer) return false;
    this.producer = producer;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.error(LAYER, 'Kafka 发件箱刷新失败', err);
      });
    }, this.config.worker.pollIntervalMs);
    this.timer.unref?.();
    this.started = true;
    this.logger.info(LAYER, `Kafka outbox producer 已启动（topic=${this.config.kafka.topic}）`);
    return true;
  }

  isHealthy(): boolean {
    return this.timer !== undefined && this.producer !== undefined;
  }

  get inflight(): number {
    return this.currentRun ? 1 : 0;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.currentRun) {
      await this.currentRun.catch(() => undefined);
    }
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = undefined;
    }
    this.started = false;
  }

  flush(batchSize = this.config.worker.batchSize): Promise<ObservabilityKafkaFlushResult> {
    if (!this.producer) {
      return Promise.resolve({
        processed: 0,
        failed: 0,
        recovered: 0,
        backlog: getObservabilityOutboxBacklog(this.tx),
      });
    }
    if (this.currentRun) return this.currentRun;
    const run = this.flushInternal(batchSize).finally(() => {
      if (this.currentRun === run) {
        this.currentRun = undefined;
      }
    });
    this.currentRun = run;
    return run;
  }

  private async flushInternal(batchSize: number): Promise<ObservabilityKafkaFlushResult> {
    const recovered = requeueStaleObservabilityEvents(this.tx, Date.now() - this.config.worker.staleProcessingMs);
    const rows = listPendingObservabilityEvents(this.tx, batchSize);
    const claimed: ObservabilityOutboxRow[] = [];

    for (const row of rows) {
      if (markObservabilityEventProcessing(this.tx, row.id)) {
        claimed.push(row);
      }
    }

    if (claimed.length === 0) {
      return {
        processed: 0,
        failed: 0,
        recovered,
        backlog: getObservabilityOutboxBacklog(this.tx),
      };
    }

    let processed = 0;
    let failed = 0;
    for (const [topic, topicRows] of groupClaimedRowsByKafkaTopic(this.tx, claimed)) {
      try {
        await this.producer!.send({
          topic,
          acks: -1,
          timeout: 30_000,
          messages: topicRows.map((row) => encodeKafkaObservabilityMessage(outboxRowToKafkaMessage(row))),
        });
        for (const row of topicRows) {
          const message = outboxRowToKafkaMessage(row);
          this.db.transaction(() => {
            applyObservabilityStoredEvent(this.tx, {
              id: message.id,
              tenantId: message.tenantId,
              eventType: message.eventType,
              payload: message.payload,
              createdAt: message.createdAt,
            });
            markObservabilityEventSent(this.tx, row.id);
          });
        }
        processed += topicRows.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const row of topicRows) {
          markObservabilityEventFailed(this.tx, row, message, this.config.worker.maxAttempts);
        }
        failed += topicRows.length;
        this.logger.warn(LAYER, 'Kafka 发件箱 topic 分发失败', {
          topic,
          failedRows: topicRows.length,
          error: message,
        });
      }
    }

    return {
      processed,
      failed,
      recovered,
      backlog: getObservabilityOutboxBacklog(this.tx),
    };
  }
}

export interface ObservabilityKafkaFlushResult {
  processed: number;
  failed: number;
  recovered: number;
  backlog: ObservabilityOutboxBacklog;
}

export class ObservabilityKafkaRollupConsumer {
  private consumer: KafkaConsumerLike | undefined;
  private running = false;
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
    private readonly config: AppConfig['observability'],
  ) {
    this.tx = db;
  }

  async start(): Promise<boolean> {
    if (this.running) return true;
    const consumer = await createKafkaConsumer(this.config, this.logger);
    if (!consumer) return false;
    this.consumer = consumer;
    const topicPattern = buildTenantKafkaTopicPattern(this.config.kafka.topic);
    await consumer.subscribe({ topic: topicPattern, fromBeginning: false });
    this.running = true;
    void consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({
        batch,
        resolveOffset,
        heartbeat,
        commitOffsetsIfNecessary,
        isRunning,
        isStale,
      }) => {
        for (const message of batch.messages) {
          if (!isRunning() || isStale()) break;
          try {
            const decoded = decodeKafkaObservabilityMessage(message.value);
            this.db.transaction(() => {
              applyObservabilityStoredEvent(this.tx, {
                id: decoded.id,
                tenantId: decoded.tenantId,
                eventType: decoded.eventType,
                payload: decoded.payload,
                createdAt: decoded.createdAt,
              });
            });
          } catch (err) {
            const fallback = extractKafkaDlqPayload(message.value, message.key);
            const errorMessage = err instanceof Error ? err.message : String(err);
            recordPlatformDlqEvent(this.db, {
              tenantId: fallback.tenantId,
              sourceComponent: 'observability_kafka_consumer',
              sourceTopic: batch.topic || this.config.kafka.topic,
              eventType: fallback.eventType,
              partitionKey: fallback.partitionKey,
              payload: fallback.payload,
              errorMessage,
            });
            this.logger.warn(LAYER, 'Kafka 观测消息处理失败，已转入 DLQ', {
              eventType: fallback.eventType,
              error: errorMessage,
            });
          }
          resolveOffset(message.offset);
          await heartbeat();
        }
        await commitOffsetsIfNecessary();
      },
    }).catch((err) => {
      this.logger.error(LAYER, 'Kafka rollup consumer 运行失败', err);
      this.running = false;
    });
    this.logger.info(
      LAYER,
      `Kafka rollup consumer 已启动（group=${this.config.kafka.consumerGroupId}, topicPattern=${topicPattern.toString()}）`,
    );
    return true;
  }

  isHealthy(): boolean {
    return this.running && this.consumer !== undefined;
  }

  get inflight(): number {
    return this.running ? 1 : 0;
  }

  async stop(): Promise<void> {
    if (!this.consumer) return;
    await this.consumer.stop();
    await this.consumer.disconnect();
    this.consumer = undefined;
    this.running = false;
  }
}

async function createKafkaProducer(config: AppConfig['observability'], logger: Logger): Promise<KafkaProducerLike | null> {
  const kafka = await createKafkaClient(config, logger);
  if (!kafka) return null;
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  await producer.connect();
  return producer;
}

async function createKafkaConsumer(config: AppConfig['observability'], logger: Logger): Promise<KafkaConsumerLike | null> {
  const kafka = await createKafkaClient(config, logger);
  if (!kafka) return null;
  const consumer = kafka.consumer({
    groupId: config.kafka.consumerGroupId,
    allowAutoTopicCreation: false,
  });
  await consumer.connect();
  return consumer;
}

async function createKafkaClient(config: AppConfig['observability'], logger: Logger): Promise<KafkaClientLike | null> {
  const module = await loadKafkaModule();
  if (!module) {
    logger.warn(LAYER, '未安装 kafkajs，Kafka 观测链路将回退到 DB worker');
    return null;
  }
  if (!config.kafka.brokers.length) {
    logger.warn(LAYER, 'Kafka 已启用但 brokers 为空，回退到 DB worker');
    return null;
  }

  const sasl = config.kafka.saslMechanism && config.kafka.username && config.kafka.password
    ? {
      mechanism: config.kafka.saslMechanism,
      username: config.kafka.username,
      password: config.kafka.password,
    }
    : undefined;

  return new module.Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    ssl: config.kafka.ssl,
    sasl,
  });
}

function isModuleNotFoundError(err: unknown, moduleName: string): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  return code === 'ERR_MODULE_NOT_FOUND' && err.message.includes(moduleName);
}

function groupClaimedRowsByKafkaTopic(
  tx: SyncWriteUnitOfWork,
  rows: ObservabilityOutboxRow[],
): Map<string, ObservabilityOutboxRow[]> {
  const grouped = new Map<string, ObservabilityOutboxRow[]>();
  for (const row of rows) {
    const topic = resolveTenantKafkaTopic(tx, row.tenant_id, row.topic);
    const bucket = grouped.get(topic);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(topic, [row]);
    }
  }
  return grouped;
}

function extractKafkaDlqPayload(
  value: Buffer | string | null,
  key: Buffer | null,
): { tenantId: string; eventType: string; partitionKey: string | null; payload: unknown } {
  const raw = value === null ? null : typeof value === 'string' ? value : value.toString('utf8');
  if (!raw) {
    return {
      tenantId: 'default',
      eventType: 'unknown',
      partitionKey: key?.toString('utf8') ?? null,
      payload: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      tenantId: typeof parsed.tenantId === 'string' ? parsed.tenantId : 'default',
      eventType: typeof parsed.eventType === 'string' ? parsed.eventType : 'unknown',
      partitionKey: typeof parsed.partitionKey === 'string'
        ? parsed.partitionKey
        : key?.toString('utf8') ?? null,
      payload: 'payload' in parsed ? parsed.payload : parsed,
    };
  } catch {
    return {
      tenantId: 'default',
      eventType: 'unknown',
      partitionKey: key?.toString('utf8') ?? null,
      payload: raw,
    };
  }
}
