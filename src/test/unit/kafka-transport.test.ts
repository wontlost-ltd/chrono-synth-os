import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { loadConfig } from '../../config/schema.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';
import {
  buildTenantKafkaTopic,
  buildTenantKafkaTopicPattern,
  resolveTenantKafkaTopic,
} from '../../enterprise/tenant-kafka-topics.js';
import { SilentLogger } from '../../utils/logger.js';
import {
  ObservabilityKafkaOutboxProducer,
  decodeKafkaObservabilityMessage,
  encodeKafkaObservabilityMessage,
  outboxRowToKafkaMessage,
} from '../../observability/kafka-transport.js';
import {
  ObservabilityPipelineService,
  parseKafkaBrokerAddress,
} from '../../observability/observability-pipeline-service.js';
import {
  OBSERVABILITY_TOPIC,
  getObservabilityRollup,
  publishObservabilityEvent,
} from '../../observability/observability-outbox.js';

describe('Kafka transport helpers', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
  });

  it('支持 tenant Kafka namespace 的 topic 组装与匹配', () => {
    const topic = buildTenantKafkaTopic(OBSERVABILITY_TOPIC, 'tenant-enterprise');
    const pattern = buildTenantKafkaTopicPattern(OBSERVABILITY_TOPIC);

    assert.equal(topic, 'tenant-enterprise.observability.events');
    assert.equal(pattern.test(OBSERVABILITY_TOPIC), true);
    assert.equal(pattern.test('tenant-enterprise.observability.events'), true);
    assert.equal(pattern.test('tenant-enterprise.other.events'), false);
  });

  it('可根据 enterprise deployment profile 解析 tenant Kafka topic', () => {
    const service = new TenantEnterpriseProfileService(db, loadConfig({}));
    service.upsertProfile('tenant-enterprise', {
      deploymentMode: 'dedicated_db',
      kafkaNamespace: 'tenant-enterprise',
    });
    service.upsertProfile('tenant-auto', {
      deploymentMode: 'dedicated_db',
    });

    assert.equal(
      resolveTenantKafkaTopic(db, 'tenant-enterprise', OBSERVABILITY_TOPIC),
      'tenant-enterprise.observability.events',
    );
    assert.equal(
      resolveTenantKafkaTopic(db, 'tenant-auto', OBSERVABILITY_TOPIC),
      'tenant-tenant-auto.observability.events',
    );
    assert.equal(resolveTenantKafkaTopic(db, 'tenant-shared', OBSERVABILITY_TOPIC), OBSERVABILITY_TOPIC);
  });

  it('可以把 outbox row 编码并解码为 Kafka 消息', () => {
    const id = publishObservabilityEvent(db, {
      tenantId: 'tenant_kafka',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_1',
      payload: {
        durationMs: 1234,
        updatedAt: 2000,
      },
    });

    const row = db.prepare<{
      id: string;
      tenant_id: string;
      topic: string;
      event_type: 'runtime.completed';
      partition_key: string;
      payload_json: string;
      status: 'pending';
      attempts: number;
      created_at: number;
      processed_at: number | null;
      last_error: string | null;
    }>('SELECT * FROM observability_outbox WHERE id = ?').get(id);
    assert.ok(row);

    const message = outboxRowToKafkaMessage(row!);
    const encoded = encodeKafkaObservabilityMessage(message);
    const decoded = decodeKafkaObservabilityMessage(encoded.value);

    assert.equal(decoded.id, message.id);
    assert.equal(decoded.tenantId, 'tenant_kafka');
    assert.equal(decoded.eventType, 'runtime.completed');
    assert.equal(decoded.partitionKey, 'runtime_1');
    assert.equal((decoded.payload.durationMs as number), 1234);
  });

  it('Kafka outbox producer 会按 tenant namespace 分 topic 发送', async () => {
    const profileService = new TenantEnterpriseProfileService(db, loadConfig({}));
    profileService.upsertProfile('tenant-enterprise', {
      deploymentMode: 'dedicated_db',
      kafkaNamespace: 'tenant-enterprise',
    });

    const sharedEventId = publishObservabilityEvent(db, {
      tenantId: 'tenant-shared',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'task.outcome',
      partitionKey: 'task_1',
      payload: {
        status: 'completed',
      },
    });
    const dedicatedEventId = publishObservabilityEvent(db, {
      tenantId: 'tenant-enterprise',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_1',
      payload: {
        durationMs: 321,
      },
    });

    const config = loadConfig({
      observability: {
        worker: {
          enabled: true,
          pollIntervalMs: 1000,
          batchSize: 10,
          maxAttempts: 5,
          staleProcessingMs: 1000,
        },
        kafka: {
          enabled: true,
          brokers: ['kafka-native:9092'],
          clientId: 'test',
          topic: OBSERVABILITY_TOPIC,
          consumerGroupId: 'test-group',
          ssl: false,
        },
      },
    });
    const logger = new SilentLogger();
    const producer = new ObservabilityKafkaOutboxProducer(db, logger, config.observability);

    const sentBatches: Array<{ topic: string; ids: string[] }> = [];
    const fakeProducer = {
      connect: async () => {},
      disconnect: async () => {},
      send: async (payload: {
        topic: string;
        messages: Array<{ value: string }>;
      }) => {
        sentBatches.push({
          topic: payload.topic,
          ids: payload.messages.map((message) => decodeKafkaObservabilityMessage(message.value).id),
        });
      },
    };
    (producer as unknown as { producer: typeof fakeProducer }).producer = fakeProducer;

    const result = await producer.flush(10);
    const sentTopics = sentBatches.map((batch) => batch.topic).sort();
    const statuses = db.prepare<{ id: string; status: string }>(
      'SELECT id, status FROM observability_outbox WHERE id IN (?, ?) ORDER BY id ASC',
    ).all(dedicatedEventId, sharedEventId).map((row) => ({
      id: row.id,
      status: row.status,
    }));

    assert.equal(result.processed, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(sentTopics, [
      OBSERVABILITY_TOPIC,
      'tenant-enterprise.observability.events',
    ]);
    assert.deepEqual(
      sentBatches.find((batch) => batch.topic === OBSERVABILITY_TOPIC)?.ids,
      [sharedEventId],
    );
    assert.deepEqual(
      sentBatches.find((batch) => batch.topic === 'tenant-enterprise.observability.events')?.ids,
      [dedicatedEventId],
    );
    assert.deepEqual(statuses, [
      { id: dedicatedEventId, status: 'sent' },
      { id: sharedEventId, status: 'sent' },
    ].sort((left, right) => left.id.localeCompare(right.id)));

    const sharedRollup = getObservabilityRollup(db, 'tenant-shared');
    const dedicatedRollup = getObservabilityRollup(db, 'tenant-enterprise');
    assert.equal(sharedRollup.task_terminal_count, 1);
    assert.equal(sharedRollup.task_success_count, 0);
    assert.equal(dedicatedRollup.runtime_completed_count, 1);
  });

  it('pipeline service 在 kafka 关闭时走 direct worker 模式', async () => {
    const logger = new SilentLogger();
    const config = loadConfig({
      observability: {
        worker: {
          enabled: true,
          pollIntervalMs: 1000,
          batchSize: 10,
          maxAttempts: 5,
          staleProcessingMs: 1000,
        },
        kafka: {
          enabled: false,
          brokers: [],
          clientId: 'test',
          topic: 'observability.events',
          consumerGroupId: 'test-group',
          ssl: false,
        },
      },
    });

    const pipeline = new ObservabilityPipelineService(db, logger, config.observability);
    await pipeline.start();

    assert.equal(pipeline.activeMode, 'direct');
    assert.equal(pipeline.isHealthy(), true);

    await pipeline.stop();
    assert.equal(pipeline.activeMode, 'stopped');
  });

  it('可解析 Kafka broker 地址', () => {
    assert.deepEqual(parseKafkaBrokerAddress('kafka-native:9092'), {
      host: 'kafka-native',
      port: 9092,
    });
    assert.deepEqual(parseKafkaBrokerAddress('[::1]:9092'), {
      host: '::1',
      port: 9092,
    });
    assert.equal(parseKafkaBrokerAddress('invalid-broker'), null);
    assert.equal(parseKafkaBrokerAddress('broker:not-a-port'), null);
  });
});
