/**
 * KafkaNamespaceProvisioner — 租户 Kafka 命名空间自动创建
 *
 * 当租户切换到 dedicated_db 部署模式时，负责在 Kafka broker 上
 * 创建该租户专属的 topic（幂等，已存在则跳过）。
 *
 * 设计约束：
 * - 无状态，每次调用均幂等
 * - Kafka Admin 连接按需创建，用完立即断开
 * - 不抛异常：失败时记录日志并返回 ProvisionResult，由调用方决策
 * - 仅在 config.observability.kafka.enabled 为 true 时才连接 broker
 */

import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import {
  buildTenantKafkaTopic,
  defaultKafkaNamespaceForTenant,
} from './tenant-kafka-topics.js';

const LAYER = 'KafkaNamespaceProvisioner';

/** Kafka broker 上为租户创建的 topic 列表（每种基础 topic 一个） */
const BASE_TOPICS = [
  'observability.events',
];

export interface ProvisionResult {
  tenantId: string;
  kafkaNamespace: string;
  topics: string[];
  status: 'created' | 'already_exists' | 'skipped' | 'error';
  error?: string;
}

interface KafkaAdminLike {
  connect(): Promise<void>;
  createTopics(options: {
    topics: Array<{
      topic: string;
      numPartitions?: number;
      replicationFactor?: number;
      configEntries?: Array<{ name: string; value: string }>;
    }>;
    waitForLeaders?: boolean;
    timeout?: number;
  }): Promise<boolean>;
  listTopics(): Promise<string[]>;
  disconnect(): Promise<void>;
}

interface KafkaModuleLike {
  Kafka: new (opts: Record<string, unknown>) => {
    admin(opts?: Record<string, unknown>): KafkaAdminLike;
  };
}

async function loadKafkaModule(): Promise<KafkaModuleLike | null> {
  try {
    return await import('kafkajs') as unknown as KafkaModuleLike;
  } catch {
    return null;
  }
}

async function createAdmin(config: AppConfig, logger: Logger): Promise<KafkaAdminLike | null> {
  const kafkaCfg = config.observability.kafka;
  if (!kafkaCfg.enabled || !kafkaCfg.brokers.length) {
    logger.info(LAYER, 'Kafka 未启用或 brokers 为空，跳过 topic 创建');
    return null;
  }

  const module = await loadKafkaModule();
  if (!module) {
    logger.warn(LAYER, '未安装 kafkajs，无法创建 topic');
    return null;
  }

  const sasl = kafkaCfg.saslMechanism && kafkaCfg.username && kafkaCfg.password
    ? { mechanism: kafkaCfg.saslMechanism, username: kafkaCfg.username, password: kafkaCfg.password }
    : undefined;

  const kafka = new module.Kafka({
    clientId: `${kafkaCfg.clientId}-provisioner`,
    brokers: kafkaCfg.brokers,
    ssl: kafkaCfg.ssl,
    sasl,
  });

  return kafka.admin();
}

/**
 * 为租户创建 Kafka topic（幂等）。
 * 在以下情况下调用：
 * - 租户 upsertProfile 后 deploymentMode 变为 'dedicated_db'
 * - 管理员手动触发重新配置
 */
export async function provisionTenantKafkaNamespace(
  tenantId: string,
  kafkaNamespace: string | null,
  config: AppConfig,
  logger: Logger,
): Promise<ProvisionResult> {
  const resolvedNamespace = kafkaNamespace ?? defaultKafkaNamespaceForTenant(tenantId);

  const topics = BASE_TOPICS.map((base) =>
    buildTenantKafkaTopic(base, resolvedNamespace),
  );

  const admin = await createAdmin(config, logger);
  if (!admin) {
    return {
      tenantId,
      kafkaNamespace: resolvedNamespace,
      topics,
      status: 'skipped',
    };
  }

  try {
    await admin.connect();

    const existing = new Set(await admin.listTopics());
    const toCreate = topics.filter((t) => !existing.has(t));

    if (toCreate.length === 0) {
      logger.info(LAYER, `租户 ${tenantId} 所有 topic 已存在，跳过创建`);
      return { tenantId, kafkaNamespace: resolvedNamespace, topics, status: 'already_exists' };
    }

    const kafkaCfg = config.observability.kafka;
    await admin.createTopics({
      topics: toCreate.map((topic) => ({
        topic,
        numPartitions: 3,
        replicationFactor: Math.min(kafkaCfg.brokers.length, 3),
        configEntries: [
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
          { name: 'cleanup.policy', value: 'delete' },
        ],
      })),
      waitForLeaders: true,
      timeout: 10_000,
    });

    logger.info(LAYER, `租户 ${tenantId} 创建了 topic: ${toCreate.join(', ')}`);
    return { tenantId, kafkaNamespace: resolvedNamespace, topics, status: 'created' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(LAYER, `租户 ${tenantId} 创建 topic 失败: ${error}`);
    return { tenantId, kafkaNamespace: resolvedNamespace, topics, status: 'error', error };
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
