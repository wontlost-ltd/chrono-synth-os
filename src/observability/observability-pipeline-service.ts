import type { AppConfig } from '../config/schema.js';
import { Socket } from 'node:net';
import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { ObservabilityKafkaOutboxProducer, ObservabilityKafkaRollupConsumer } from './kafka-transport.js';
import { ObservabilityWorker } from './observability-worker.js';

const LAYER = 'ObservabilityPipeline';

export class ObservabilityPipelineService {
  private directWorker: ObservabilityWorker | undefined;
  private kafkaProducer: ObservabilityKafkaOutboxProducer | undefined;
  private kafkaConsumer: ObservabilityKafkaRollupConsumer | undefined;
  private mode: 'stopped' | 'direct' | 'kafka' = 'stopped';

  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
    private readonly config: AppConfig['observability'],
  ) {}

  async start(): Promise<void> {
    if (this.mode !== 'stopped') return;

    if (this.config.kafka.enabled) {
      await waitForKafkaBrokers(this.config, this.logger);
      const producer = new ObservabilityKafkaOutboxProducer(this.db, this.logger, this.config);
      const consumer = new ObservabilityKafkaRollupConsumer(this.db, this.logger, this.config);
      const producerStarted = await producer.start();
      const consumerStarted = await consumer.start();
      if (producerStarted && consumerStarted) {
        this.kafkaProducer = producer;
        this.kafkaConsumer = consumer;
        this.mode = 'kafka';
        this.logger.info(LAYER, 'Kafka 观测管线已启动');
        return;
      }
      await producer.stop().catch(() => undefined);
      await consumer.stop().catch(() => undefined);
      this.logger.warn(LAYER, 'Kafka 观测链路不可用，回退到 DB worker');
    }

    this.directWorker = new ObservabilityWorker(this.db, this.logger, {
      pollIntervalMs: this.config.worker.pollIntervalMs,
      batchSize: this.config.worker.batchSize,
      maxAttempts: this.config.worker.maxAttempts,
      staleProcessingMs: this.config.worker.staleProcessingMs,
    });
    this.directWorker.start();
    this.mode = 'direct';
    this.logger.info(LAYER, 'DB 观测 worker 已启动');
  }

  isHealthy(): boolean {
    switch (this.mode) {
      case 'kafka':
        return Boolean(this.kafkaProducer?.isHealthy() && this.kafkaConsumer?.isHealthy());
      case 'direct':
        return Boolean(this.directWorker?.isHealthy());
      case 'stopped':
      default:
        return false;
    }
  }

  get inflight(): number {
    switch (this.mode) {
      case 'kafka':
        return (this.kafkaProducer?.inflight ?? 0) + (this.kafkaConsumer?.inflight ?? 0);
      case 'direct':
        return this.directWorker?.inflight ?? 0;
      case 'stopped':
      default:
        return 0;
    }
  }

  get activeMode(): 'stopped' | 'direct' | 'kafka' {
    return this.mode;
  }

  async stop(): Promise<void> {
    await this.kafkaProducer?.stop();
    await this.kafkaConsumer?.stop();
    await this.directWorker?.stop();
    this.kafkaProducer = undefined;
    this.kafkaConsumer = undefined;
    this.directWorker = undefined;
    this.mode = 'stopped';
  }
}

export function parseKafkaBrokerAddress(broker: string): { host: string; port: number } | null {
  const trimmed = broker.trim();
  const separator = trimmed.lastIndexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return null;

  const host = trimmed.slice(0, separator).replace(/^\[|\]$/g, '');
  const port = Number.parseInt(trimmed.slice(separator + 1), 10);
  if (!host || Number.isNaN(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

async function waitForKafkaBrokers(
  config: AppConfig['observability'],
  logger: Logger,
): Promise<void> {
  const timeoutMs = config.kafka.startupWaitMs;
  if (timeoutMs <= 0 || config.kafka.brokers.length === 0) return;

  const brokers = config.kafka.brokers
    .map(parseKafkaBrokerAddress)
    .filter((broker): broker is { host: string; port: number } => broker !== null);
  if (brokers.length === 0) return;

  const deadline = Date.now() + timeoutMs;
  let announcedWaiting = false;
  while (Date.now() <= deadline) {
    for (const broker of brokers) {
      if (await isTcpReachable(broker.host, broker.port)) {
        if (announcedWaiting) {
          logger.info(LAYER, `Kafka broker 已可达（${broker.host}:${broker.port}）`);
        }
        return;
      }
    }

    if (!announcedWaiting) {
      announcedWaiting = true;
      logger.info(LAYER, `等待 Kafka broker 就绪（timeout=${timeoutMs}ms）`);
    }
    await delay(1000);
  }

  logger.warn(LAYER, 'Kafka broker 在启动等待窗口内不可达，将继续尝试启动并允许回退到 DB worker');
}

async function isTcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finalize = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
    socket.connect(port, host);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
