import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { loadConfig } from '../../config/schema.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
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
  markObservabilityEventProcessing,
  publishObservabilityEvent,
} from '../../observability/observability-outbox.js';

describe('Kafka transport helpers', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
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
    const service = new TenantEnterpriseProfileService(new SingleDbResolver(db), loadConfig({}));
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
    const profileService = new TenantEnterpriseProfileService(new SingleDbResolver(db), loadConfig({}));
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

  /* ── issue #380：kafka 侧的 stale 回收调用点也必须有覆盖 ────────── */
  it('★回归★ kafka producer 会回收卡在 processing 的陈旧事件（issue #380 调用点）', async () => {
    /**
     * ⚠️ 这条用例是独立审查逼出来的，缺口很具体：
     *
     * `requeueStaleObservabilityEvents` 的参数语义从「绝对截止时刻」改成了「时长」，
     * **两者都是 `number`，TypeScript 拦不住**。我在本 PR 里已经漏改过一次调用点
     * （observability-worker），靠一条**既有**用例才发现。
     *
     * 而 kafka-transport 这个调用点当时**零覆盖**：把它回退成
     * `Date.now() - staleProcessingMs` 后编译通过、全套 13/13 全绿。
     * 实测该回退的真实后果：实参 ≈1.787e12 被当成时长 → 截止点 ≈ epoch 1000 →
     * **回收 0 条、卡住的事件永远停在 processing**（stale 回收彻底失效，且静默）。
     *
     * 故此处按真实路径（producer.flush）钉死：卡住的必须被回收、刚认领的不得被回收。
     */
    const eventId = publishObservabilityEvent(db, {
      tenantId: 'tenant_kafka_stale',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_stale',
      payload: { durationMs: 42 },
    });
    assert.equal(markObservabilityEventProcessing(db, eventId), true, '前置：应能认领');
    /* 认领时刻挪到 10 分钟前，模拟消费者崩溃后卡住。 */
    db.prepare<void>(
      'UPDATE observability_outbox SET processed_at = ? WHERE id = ?',
    ).run(Date.now() - 10 * 60 * 1000, eventId);

    /* 另有一条**刚认领**的：它绝不能被顺带回收（防「干脆全收」的假通过）。 */
    const freshId = publishObservabilityEvent(db, {
      tenantId: 'tenant_kafka_stale',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_fresh',
      payload: { durationMs: 7 },
    });
    assert.equal(markObservabilityEventProcessing(db, freshId), true);

    const config = loadConfig({
      observability: {
        worker: {
          enabled: true, pollIntervalMs: 1000, batchSize: 10,
          maxAttempts: 5, staleProcessingMs: 5 * 60 * 1000,
        },
        kafka: {
          enabled: true, brokers: ['kafka-native:9092'], clientId: 'test',
          topic: OBSERVABILITY_TOPIC, consumerGroupId: 'test-group', ssl: false,
        },
      },
    });
    const producer = new ObservabilityKafkaOutboxProducer(db, new SilentLogger(), config.observability);
    (producer as unknown as { producer: { connect: () => Promise<void>; disconnect: () => Promise<void>;
      send: (p: { topic: string; messages: Array<{ value: string }> }) => Promise<void> } }).producer = {
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
    };

    const result = await producer.flush(10);

    assert.equal(result.recovered, 1, '卡住 10 分钟的事件必须被回收（回退成绝对截止点时此处为 0）');

    const freshStatus = db.prepare<{ status: string }>(
      'SELECT status FROM observability_outbox WHERE id = ?',
    ).all(freshId)[0]?.status;
    assert.notEqual(freshStatus, 'pending', '刚认领的事件不得被回收成 pending');
  });
});
