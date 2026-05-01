/**
 * 配置 schema 定义与加载逻辑
 * 合并优先级：defaults < 配置文件 < 环境变量 < 构造函数注入
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { LogLevel } from '../utils/logger.js';

const dbPoolSchema = z.object({
  max: z.coerce.number().int().min(1).default(10),
  idleTimeoutMs: z.coerce.number().int().default(30_000),
});

const dbSchema = z.object({
  driver: z.enum(['sqlite', 'postgres']).default('sqlite'),
  path: z.string().default(':memory:'),
  connectionString: z.string().optional(),
  pool: dbPoolSchema.default({ max: 10, idleTimeoutMs: 30_000 }),
});

const logSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  json: z.boolean().default(false),
});

const serverSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  publicUrl: z.string().url().optional(),
});

const integrationSchema = z.object({
  fitnessThreshold: z.coerce.number().min(0).max(1).default(0.6),
  confidenceThreshold: z.coerce.number().min(0).max(1).default(0.5),
});

const rateLimitSchema = z.object({
  max: z.coerce.number().int().min(1).default(100),
  timeWindowMs: z.coerce.number().int().min(1000).default(60_000),
});

const websocketSchema = z.object({
  enabled: z.boolean().default(true),
  heartbeatIntervalMs: z.coerce.number().int().min(1000).default(30_000),
  /** WebSocket 事件日志保留窗口（毫秒），默认 1 小时 */
  eventLogRetentionMs: z.coerce.number().int().min(60_000).default(60 * 60 * 1000),
  /** 断线重连重放最大事件数，默认 1000 */
  replayLimit: z.coerce.number().int().min(100).max(10_000).default(1000),
});

const corsSchema = z.object({
  origin: z.union([z.string(), z.array(z.string()), z.boolean()]).default(false),
  credentials: z.boolean().default(false),
});

const authSchema = z.object({
  enabled: z.boolean().default(false),
  apiKeys: z.array(z.string()).default([]),
  /** 仅用于 /metrics 与 /metrics/prometheus 的静态 scrape key，可与 requireDbKeys 共存 */
  metricsApiKeys: z.array(z.string()).default([]),
  /** 生产环境强制使用 DB 存储的 API Key（禁用静态配置 Key 回退） */
  requireDbKeys: z.boolean().default(false),
});

const jwtSchema = z.object({
  enabled: z.boolean().default(false),
  secret: z.string().default('change-me-in-production'),
  issuer: z.string().default('chrono-synth-os'),
  accessTtlMs: z.coerce.number().int().default(15 * 60 * 1000),       /* 15 分钟 */
  refreshTtlMs: z.coerce.number().int().default(7 * 24 * 60 * 60 * 1000), /* 7 天 */
  algorithm: z.enum(['HS256', 'HS384', 'HS512']).default('HS256'),
});

const redisSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('redis://localhost:6379'),
  keyPrefix: z.string().default('chrono:'),
  tls: z.boolean().default(false),
});

const stripeSchema = z.object({
  enabled: z.boolean().default(false),
  secretKey: z.string().default(''),
  webhookSecret: z.string().default(''),
  publishableKey: z.string().default(''),
});

const billingSchema = z.object({
  reconciliation: z.object({
    enabled: z.boolean().default(false),
    pollIntervalMs: z.coerce.number().int().min(1_000).default(5 * 60 * 1000),
    batchSize: z.coerce.number().int().min(1).default(100),
  }).default({
    enabled: false,
    pollIntervalMs: 5 * 60 * 1000,
    batchSize: 100,
  }),
}).default({
  reconciliation: {
    enabled: false,
    pollIntervalMs: 5 * 60 * 1000,
    batchSize: 100,
  },
});

const cognitionDecaySchema = z.object({
  baseLambda: z.coerce.number().min(0).default(0.0001),
  valenceWeight: z.coerce.number().min(0).max(1).default(0.3),
  accessBoost: z.coerce.number().min(0).default(0.5),
  kindFactors: z.object({
    episodic: z.coerce.number().min(0).default(1.0),
    semantic: z.coerce.number().min(0).default(0.5),
    procedural: z.coerce.number().min(0).default(0.3),
  }).default({ episodic: 1.0, semantic: 0.5, procedural: 0.3 }),
}).default({ baseLambda: 0.0001, valenceWeight: 0.3, accessBoost: 0.5, kindFactors: { episodic: 1.0, semantic: 0.5, procedural: 0.3 } });

const cognitionEvictionSchema = z.object({
  salienceFloor: z.coerce.number().min(0).max(1).default(0.01),
  maxMemoryNodes: z.coerce.number().int().default(10_000),
  capacityTargetRatio: z.coerce.number().min(0.8).max(0.99).default(0.9),
  deleteConsolidatedSources: z.boolean().default(true),
  batchSize: z.coerce.number().int().min(1).default(1000),
}).default({ salienceFloor: 0.01, maxMemoryNodes: 10_000, capacityTargetRatio: 0.9, deleteConsolidatedSources: true, batchSize: 1000 });

const cognitionSchema = z.object({
  decay: cognitionDecaySchema,
  activation: z.object({
    baseActivation: z.coerce.number().min(0).max(1).default(0.1),
    damping: z.coerce.number().min(0).default(0.5),
    maxDepth: z.coerce.number().int().min(1).max(5).default(2),
  }).default({ baseActivation: 0.1, damping: 0.5, maxDepth: 2 }),
  workingMemory: z.object({
    capacity: z.coerce.number().int().min(1).max(20).default(7),
    recencyDecay: z.coerce.number().min(0).default(0.0001),
  }).default({ capacity: 7, recencyDecay: 0.0001 }),
  consolidation: z.object({
    accessThreshold: z.coerce.number().int().min(1).default(5),
    minSalience: z.coerce.number().min(0).max(1).default(0.3),
  }).default({ accessThreshold: 5, minSalience: 0.3 }),
  eviction: cognitionEvictionSchema,
}).default({
  decay: { baseLambda: 0.0001, valenceWeight: 0.3, accessBoost: 0.5, kindFactors: { episodic: 1.0, semantic: 0.5, procedural: 0.3 } },
  activation: { baseActivation: 0.1, damping: 0.5, maxDepth: 2 },
  workingMemory: { capacity: 7, recencyDecay: 0.0001 },
  consolidation: { accessThreshold: 5, minSalience: 0.3 },
  eviction: { salienceFloor: 0.01, maxMemoryNodes: 10_000, capacityTargetRatio: 0.9, deleteConsolidatedSources: true, batchSize: 1000 },
});

const intelligenceSimulationSchema = z.object({
  rollouts: z.coerce.number().int().min(1).max(10).default(3),
  maxOptions: z.coerce.number().int().min(2).max(6).default(4),
}).default({ rollouts: 3, maxOptions: 4 });

const intelligenceBudgetSchema = z.object({
  monthlyTokenLimit: z.coerce.number().int().min(0).default(1_000_000),
  dailyTokenLimit: z.coerce.number().int().min(0).default(100_000),
  alertThreshold: z.coerce.number().min(0).max(1).default(0.8),
}).default({ monthlyTokenLimit: 1_000_000, dailyTokenLimit: 100_000, alertThreshold: 0.8 });

const intelligenceSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'ollama', 'mock']).default('mock'),
  model: z.string().default('claude-sonnet-4-5-20250929'),
  embeddingModel: z.string().default('text-embedding-3-small'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  maxTokens: z.coerce.number().int().default(4096),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  simulation: intelligenceSimulationSchema,
  budget: intelligenceBudgetSchema,
});

const encryptionSchema = z.object({
  enabled: z.boolean().default(false),
  masterKey: z.string().default('change-me-in-production-32chars!'),
  defaultKeyRef: z.string().default('master'),
  keyring: z.record(z.string(), z.string()).default({}),
  keyRotationIntervalDays: z.coerce.number().int().min(1).default(90),
});

const ssoSchema = z.object({
  enabled: z.boolean().default(false),
  domain: z.string().default(''),
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  audience: z.string().default(''),
});

const oidcSchema = z.object({
  enabled: z.boolean().default(false),
  issuerUrl: z.string().default(''),
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  audience: z.string().default(''),
  scope: z.string().default('openid profile email'),
  emailClaim: z.string().default('email'),
  nameClaim: z.string().default('name'),
});

const ruleEngineSchema = z.object({
  enabled: z.boolean().default(true),
  fallbackStrategy: z.enum(['rule_only', 'error']).default('rule_only'),
}).default({ enabled: true, fallbackStrategy: 'rule_only' });

const onboardingSchema = z.object({
  predefinedValues: z.array(z.string()).default([
    '好奇心', '诚信', '稳定', '成长', '同理心',
    '自律', '创造力', '自由', '影响力', '学习',
    '健康', '家庭', '社区', '勇气', '专注',
    '平衡', '诚实', '坚韧', '创新', '精通',
  ]),
  maxImportEntries: z.coerce.number().int().min(1).default(100),
});

const observabilityWorkerSchema = z.object({
  enabled: z.boolean().default(false),
  pollIntervalMs: z.coerce.number().int().min(100).default(1000),
  batchSize: z.coerce.number().int().min(1).default(100),
  maxAttempts: z.coerce.number().int().min(1).default(5),
  staleProcessingMs: z.coerce.number().int().min(1000).default(5 * 60 * 1000),
  http: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().int().min(1).max(65535).default(3100),
  }).default({
    enabled: true,
    host: '0.0.0.0',
    port: 3100,
  }),
}).default({
  enabled: false,
  pollIntervalMs: 1000,
  batchSize: 100,
  maxAttempts: 5,
  staleProcessingMs: 5 * 60 * 1000,
  http: {
    enabled: true,
    host: '0.0.0.0',
    port: 3100,
  },
});

const observabilityKafkaSchema = z.object({
  enabled: z.boolean().default(false),
  brokers: z.array(z.string()).default([]),
  clientId: z.string().default('chrono-synth-os'),
  topic: z.string().default('observability.events'),
  consumerGroupId: z.string().default('chrono-synth-observability'),
  startupWaitMs: z.coerce.number().int().min(0).default(30_000),
  ssl: z.boolean().default(false),
  saslMechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
}).default({
  enabled: false,
  brokers: [],
  clientId: 'chrono-synth-os',
  topic: 'observability.events',
  consumerGroupId: 'chrono-synth-observability',
  startupWaitMs: 30_000,
  ssl: false,
});

const observabilitySchema = z.object({
  enabled: z.boolean().default(false),
  otlpEndpoint: z.string().default('http://localhost:4318'),
  serviceName: z.string().default('chrono-synth-os'),
  serviceVersion: z.string().default('2.0.0'),
  sampleRate: z.coerce.number().min(0).max(1).default(1.0),
  /** 租户使用量指标保留窗口（毫秒），默认 7 天 */
  metricsRetentionMs: z.coerce.number().int().min(3_600_000).default(7 * 24 * 60 * 60 * 1000),
  worker: observabilityWorkerSchema,
  kafka: observabilityKafkaSchema,
});

const queueSchema = z.object({
  enabled: z.boolean().default(false),
  pollIntervalMs: z.coerce.number().int().min(100).default(1000),
  maxConcurrent: z.coerce.number().int().min(1).default(2),
  maxRetries: z.coerce.number().int().min(0).default(3),
  /** 每租户最大待处理任务数（0=无限制） */
  maxPendingPerTenant: z.coerce.number().int().min(0).default(1000),
  /** 已完成/失败任务保留时长（毫秒），默认 7 天 */
  completedRetentionMs: z.coerce.number().int().min(3_600_000).default(7 * 24 * 60 * 60 * 1000),
});

const idempotencySchema = z.object({
  enabled: z.boolean().default(true),
  ttlMs: z.coerce.number().int().min(60_000).default(24 * 60 * 60 * 1000),
}).default({ enabled: true, ttlMs: 24 * 60 * 60 * 1000 });

const avatarAutorunSchema = z.object({
  schedulerIntervalMs: z.coerce.number().int().min(10_000).default(60_000),
  maxItemsPerRun: z.coerce.number().int().min(1).default(100),
  defaultDriftThreshold: z.coerce.number().min(0).max(1).default(0.3),
  sourceTimeoutMs: z.coerce.number().int().min(1_000).default(30_000),
  maxSourcesPerAvatar: z.coerce.number().int().min(1).default(50),
}).default({
  schedulerIntervalMs: 60_000,
  maxItemsPerRun: 100,
  defaultDriftThreshold: 0.3,
  sourceTimeoutMs: 30_000,
  maxSourcesPerAvatar: 50,
});

const sseSchema = z.object({
  enabled: z.boolean().default(true),
  maxConnectionsPerTenant: z.coerce.number().int().min(1).default(50),
}).default({ enabled: true, maxConnectionsPerTenant: 50 });

const requestSchema = z.object({
  timeoutMs: z.coerce.number().int().min(0).default(30_000),
  maxBodyBytes: z.coerce.number().int().min(1024).default(1_048_576),
});

/** 对象存储（导出包上传）配置 */
const objectStorageSchema = z.object({
  provider: z.enum(['local', 's3', 'gcs', 'azure_blob']).default('local'),
  // S3 / S3 兼容（MinIO 等）
  s3Bucket: z.string().default(''),
  s3Region: z.string().default(''),
  s3Endpoint: z.string().default(''),
  s3AccessKeyId: z.string().default(''),
  s3SecretAccessKey: z.string().default(''),
  // Google Cloud Storage
  gcsBucket: z.string().default(''),
  gcsProjectId: z.string().default(''),
  gcsKeyFile: z.string().default(''),
  // Azure Blob Storage
  azureConnectionString: z.string().default(''),
  azureContainer: z.string().default(''),
  // 本地磁盘回退（provider=local）
  localPath: z.string().default('/tmp/chrono-exports'),
  // 预签名 URL 有效期（秒）
  presignTtlSeconds: z.coerce.number().int().min(60).default(3600),
});

const runtimeSchema = z.object({
  recovery: z.object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.coerce.number().int().min(1_000).default(5_000),
    sessionTimeoutMs: z.coerce.number().int().min(5_000).default(60_000),
    maxRetries: z.coerce.number().int().min(0).default(2),
    batchSize: z.coerce.number().int().min(1).default(100),
  }).default({
    enabled: true,
    pollIntervalMs: 5_000,
    sessionTimeoutMs: 60_000,
    maxRetries: 2,
    batchSize: 100,
  }),
});

export const AppConfigSchema = z.object({
  region: z.string().min(1).default('local'),
  db: dbSchema.default({ driver: 'sqlite', path: ':memory:', pool: { max: 10, idleTimeoutMs: 30_000 } }),
  log: logSchema.default({ level: 'info', json: false }),
  server: serverSchema.default({ host: '0.0.0.0', port: 3000 }),
  integration: integrationSchema.default({ fitnessThreshold: 0.6, confidenceThreshold: 0.5 }),
  rateLimit: rateLimitSchema.default({ max: 100, timeWindowMs: 60_000 }),
  websocket: websocketSchema.default({ enabled: true, heartbeatIntervalMs: 30_000, eventLogRetentionMs: 60 * 60 * 1000, replayLimit: 1000 }),
  cors: corsSchema.default({ origin: false, credentials: false }),
  auth: authSchema.default({ enabled: false, apiKeys: [], metricsApiKeys: [], requireDbKeys: false }),
  jwt: jwtSchema.default({
    enabled: false, secret: 'change-me-in-production', issuer: 'chrono-synth-os',
    accessTtlMs: 15 * 60 * 1000, refreshTtlMs: 7 * 24 * 60 * 60 * 1000, algorithm: 'HS256',
  }),
  redis: redisSchema.default({ enabled: false, url: 'redis://localhost:6379', keyPrefix: 'chrono:', tls: false }),
  stripe: stripeSchema.default({ enabled: false, secretKey: '', webhookSecret: '', publishableKey: '' }),
  billing: billingSchema,
  intelligence: intelligenceSchema.default({
    provider: 'mock', model: 'claude-sonnet-4-5-20250929', embeddingModel: 'text-embedding-3-small',
    maxTokens: 4096, temperature: 0.7, simulation: { rollouts: 3, maxOptions: 4 },
    budget: { monthlyTokenLimit: 1_000_000, dailyTokenLimit: 100_000, alertThreshold: 0.8 },
  }),
  encryption: encryptionSchema.default({
    enabled: false,
    masterKey: 'change-me-in-production-32chars!',
    defaultKeyRef: 'master',
    keyring: {},
    keyRotationIntervalDays: 90,
  }),
  sso: ssoSchema.default({ enabled: false, domain: '', clientId: '', clientSecret: '', audience: '' }),
  oidc: oidcSchema.default({
    enabled: false,
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
    audience: '',
    scope: 'openid profile email',
    emailClaim: 'email',
    nameClaim: 'name',
  }),
  ruleEngine: ruleEngineSchema,
  onboarding: onboardingSchema.default({
    predefinedValues: [
      '好奇心', '诚信', '稳定', '成长', '同理心',
      '自律', '创造力', '自由', '影响力', '学习',
      '健康', '家庭', '社区', '勇气', '专注',
      '平衡', '诚实', '坚韧', '创新', '精通',
    ],
    maxImportEntries: 100,
  }),
  request: requestSchema.default({ timeoutMs: 30_000, maxBodyBytes: 1_048_576 }),
  runtime: runtimeSchema.default({
    recovery: {
      enabled: true,
      pollIntervalMs: 5_000,
      sessionTimeoutMs: 60_000,
      maxRetries: 2,
      batchSize: 100,
    },
  }),
  queue: queueSchema.default({ enabled: false, pollIntervalMs: 1000, maxConcurrent: 2, maxRetries: 3, maxPendingPerTenant: 1000, completedRetentionMs: 7 * 24 * 60 * 60 * 1000 }),
  idempotency: idempotencySchema,
  observability: observabilitySchema.default({
    enabled: false, otlpEndpoint: 'http://localhost:4318', serviceName: 'chrono-synth-os',
    serviceVersion: '2.0.0', sampleRate: 1.0, metricsRetentionMs: 7 * 24 * 60 * 60 * 1000,
    worker: {
      enabled: false,
      pollIntervalMs: 1000,
      batchSize: 100,
      maxAttempts: 5,
      staleProcessingMs: 5 * 60 * 1000,
      http: {
        enabled: true,
        host: '0.0.0.0',
        port: 3100,
      },
    },
    kafka: {
      enabled: false,
      brokers: [],
      clientId: 'chrono-synth-os',
      topic: 'observability.events',
      consumerGroupId: 'chrono-synth-observability',
      startupWaitMs: 30_000,
      ssl: false,
    },
  }),
  cognition: cognitionSchema,
  avatarAutorun: avatarAutorunSchema,
  sse: sseSchema,
  objectStorage: objectStorageSchema.default({
    provider: 'local',
    s3Bucket: '', s3Region: '', s3Endpoint: '', s3AccessKeyId: '', s3SecretAccessKey: '',
    gcsBucket: '', gcsProjectId: '', gcsKeyFile: '',
    azureConnectionString: '', azureContainer: '',
    localPath: '/tmp/chrono-exports',
    presignTtlSeconds: 3600,
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/** 从环境变量读取配置（CHRONO_ 前缀） */
function fromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  const mapping: Record<string, (val: string) => void> = {
    CHRONO_REGION:                  (v) => { deepSet(env, 'region', v); },
    CHRONO_DB_DRIVER:               (v) => { deepSet(env, 'db.driver', v); },
    CHRONO_DB_PATH:                 (v) => { deepSet(env, 'db.path', v); },
    CHRONO_DB_CONNECTION_STRING:    (v) => { deepSet(env, 'db.connectionString', v); },
    CHRONO_DB_POOL_MAX:             (v) => { deepSet(env, 'db.pool.max', parseInt(v, 10)); },
    CHRONO_DB_POOL_IDLE_TIMEOUT_MS: (v) => { deepSet(env, 'db.pool.idleTimeoutMs', parseInt(v, 10)); },
    CHRONO_LOG_LEVEL:               (v) => { deepSet(env, 'log.level', v); },
    CHRONO_LOG_JSON:                (v) => { deepSet(env, 'log.json', v === 'true'); },
    CHRONO_SERVER_HOST:             (v) => { deepSet(env, 'server.host', v); },
    CHRONO_SERVER_PORT:             (v) => { deepSet(env, 'server.port', parseInt(v, 10)); },
    CHRONO_SERVER_PUBLIC_URL:       (v) => { deepSet(env, 'server.publicUrl', v); },
    CHRONO_INTEGRATION_FITNESS:     (v) => { deepSet(env, 'integration.fitnessThreshold', parseFloat(v)); },
    CHRONO_INTEGRATION_CONFIDENCE:  (v) => { deepSet(env, 'integration.confidenceThreshold', parseFloat(v)); },
    CHRONO_RATE_LIMIT_MAX:          (v) => { deepSet(env, 'rateLimit.max', parseInt(v, 10)); },
    CHRONO_RATE_LIMIT_WINDOW_MS:    (v) => { deepSet(env, 'rateLimit.timeWindowMs', parseInt(v, 10)); },
    CHRONO_WEBSOCKET_ENABLED:       (v) => { deepSet(env, 'websocket.enabled', v === 'true'); },
    CHRONO_WEBSOCKET_HEARTBEAT_MS:  (v) => { deepSet(env, 'websocket.heartbeatIntervalMs', parseInt(v, 10)); },
    CHRONO_WEBSOCKET_EVENT_LOG_RETENTION_MS: (v) => { deepSet(env, 'websocket.eventLogRetentionMs', parseInt(v, 10)); },
    CHRONO_WEBSOCKET_REPLAY_LIMIT:  (v) => { deepSet(env, 'websocket.replayLimit', parseInt(v, 10)); },
    CHRONO_CORS_ORIGIN:             (v) => { deepSet(env, 'cors.origin', v === 'true' ? true : v === 'false' ? false : v); },
    CHRONO_CORS_CREDENTIALS:        (v) => { deepSet(env, 'cors.credentials', v === 'true'); },
    CHRONO_AUTH_ENABLED:            (v) => { deepSet(env, 'auth.enabled', v === 'true'); },
    CHRONO_AUTH_API_KEYS:           (v) => { deepSet(env, 'auth.apiKeys', v.split(',')); },
    CHRONO_AUTH_METRICS_API_KEYS:   (v) => { deepSet(env, 'auth.metricsApiKeys', v.split(',').map((item) => item.trim()).filter(Boolean)); },
    CHRONO_AUTH_REQUIRE_DB_KEYS:    (v) => { deepSet(env, 'auth.requireDbKeys', v === 'true'); },
    CHRONO_INTELLIGENCE_PROVIDER:           (v) => { deepSet(env, 'intelligence.provider', v); },
    CHRONO_INTELLIGENCE_MODEL:              (v) => { deepSet(env, 'intelligence.model', v); },
    CHRONO_INTELLIGENCE_EMBEDDING_MODEL:    (v) => { deepSet(env, 'intelligence.embeddingModel', v); },
    CHRONO_INTELLIGENCE_API_KEY:            (v) => { deepSet(env, 'intelligence.apiKey', v); },
    CHRONO_INTELLIGENCE_BASE_URL:           (v) => { deepSet(env, 'intelligence.baseUrl', v); },
    CHRONO_INTELLIGENCE_MAX_TOKENS:         (v) => { deepSet(env, 'intelligence.maxTokens', parseInt(v, 10)); },
    CHRONO_INTELLIGENCE_TEMPERATURE:        (v) => { deepSet(env, 'intelligence.temperature', parseFloat(v)); },
    CHRONO_INTELLIGENCE_SIM_ROLLOUTS:       (v) => { deepSet(env, 'intelligence.simulation.rollouts', parseInt(v, 10)); },
    CHRONO_INTELLIGENCE_SIM_MAX_OPTIONS:    (v) => { deepSet(env, 'intelligence.simulation.maxOptions', parseInt(v, 10)); },
    CHRONO_REQUEST_TIMEOUT_MS:      (v) => { deepSet(env, 'request.timeoutMs', parseInt(v, 10)); },
    CHRONO_REQUEST_MAX_BODY_BYTES:  (v) => { deepSet(env, 'request.maxBodyBytes', parseInt(v, 10)); },
    CHRONO_RUNTIME_RECOVERY_ENABLED: (v) => { deepSet(env, 'runtime.recovery.enabled', v === 'true'); },
    CHRONO_RUNTIME_RECOVERY_POLL_INTERVAL_MS: (v) => { deepSet(env, 'runtime.recovery.pollIntervalMs', parseInt(v, 10)); },
    CHRONO_RUNTIME_SESSION_TIMEOUT_MS: (v) => { deepSet(env, 'runtime.recovery.sessionTimeoutMs', parseInt(v, 10)); },
    CHRONO_RUNTIME_RECOVERY_MAX_RETRIES: (v) => { deepSet(env, 'runtime.recovery.maxRetries', parseInt(v, 10)); },
    CHRONO_RUNTIME_RECOVERY_BATCH_SIZE: (v) => { deepSet(env, 'runtime.recovery.batchSize', parseInt(v, 10)); },
    CHRONO_ONBOARDING_MAX_IMPORT_ENTRIES:   (v) => { deepSet(env, 'onboarding.maxImportEntries', parseInt(v, 10)); },
    CHRONO_COGNITION_DECAY_BASE_LAMBDA:     (v) => { deepSet(env, 'cognition.decay.baseLambda', parseFloat(v)); },
    CHRONO_COGNITION_DECAY_VALENCE_WEIGHT:  (v) => { deepSet(env, 'cognition.decay.valenceWeight', parseFloat(v)); },
    CHRONO_COGNITION_DECAY_ACCESS_BOOST:    (v) => { deepSet(env, 'cognition.decay.accessBoost', parseFloat(v)); },
    CHRONO_COGNITION_ACTIVATION_BASE:       (v) => { deepSet(env, 'cognition.activation.baseActivation', parseFloat(v)); },
    CHRONO_COGNITION_ACTIVATION_DAMPING:    (v) => { deepSet(env, 'cognition.activation.damping', parseFloat(v)); },
    CHRONO_COGNITION_ACTIVATION_MAX_DEPTH:  (v) => { deepSet(env, 'cognition.activation.maxDepth', parseInt(v, 10)); },
    CHRONO_COGNITION_WM_CAPACITY:           (v) => { deepSet(env, 'cognition.workingMemory.capacity', parseInt(v, 10)); },
    CHRONO_COGNITION_WM_RECENCY_DECAY:      (v) => { deepSet(env, 'cognition.workingMemory.recencyDecay', parseFloat(v)); },
    CHRONO_COGNITION_CONSOLIDATION_THRESHOLD: (v) => { deepSet(env, 'cognition.consolidation.accessThreshold', parseInt(v, 10)); },
    CHRONO_COGNITION_CONSOLIDATION_MIN_SALIENCE: (v) => { deepSet(env, 'cognition.consolidation.minSalience', parseFloat(v)); },
    CHRONO_COGNITION_EVICTION_SALIENCE_FLOOR:    (v) => { deepSet(env, 'cognition.eviction.salienceFloor', parseFloat(v)); },
    CHRONO_COGNITION_EVICTION_MAX_MEMORY_NODES:  (v) => { deepSet(env, 'cognition.eviction.maxMemoryNodes', parseInt(v, 10)); },
    CHRONO_COGNITION_EVICTION_CAPACITY_TARGET_RATIO: (v) => { deepSet(env, 'cognition.eviction.capacityTargetRatio', parseFloat(v)); },
    CHRONO_COGNITION_EVICTION_DELETE_CONSOLIDATED_SOURCES: (v) => { deepSet(env, 'cognition.eviction.deleteConsolidatedSources', v === 'true'); },
    CHRONO_COGNITION_EVICTION_BATCH_SIZE:        (v) => { deepSet(env, 'cognition.eviction.batchSize', parseInt(v, 10)); },
    CHRONO_QUEUE_ENABLED:            (v) => { deepSet(env, 'queue.enabled', v === 'true'); },
    CHRONO_QUEUE_POLL_INTERVAL_MS:   (v) => { deepSet(env, 'queue.pollIntervalMs', parseInt(v, 10)); },
    CHRONO_QUEUE_MAX_CONCURRENT:     (v) => { deepSet(env, 'queue.maxConcurrent', parseInt(v, 10)); },
    CHRONO_QUEUE_MAX_RETRIES:        (v) => { deepSet(env, 'queue.maxRetries', parseInt(v, 10)); },
    CHRONO_QUEUE_MAX_PENDING_PER_TENANT: (v) => { deepSet(env, 'queue.maxPendingPerTenant', parseInt(v, 10)); },
    CHRONO_QUEUE_COMPLETED_RETENTION_MS: (v) => { deepSet(env, 'queue.completedRetentionMs', parseInt(v, 10)); },
    CHRONO_IDEMPOTENCY_ENABLED:     (v) => { deepSet(env, 'idempotency.enabled', v === 'true'); },
    CHRONO_IDEMPOTENCY_TTL_MS:      (v) => { deepSet(env, 'idempotency.ttlMs', parseInt(v, 10)); },
    CHRONO_JWT_ENABLED:              (v) => { deepSet(env, 'jwt.enabled', v === 'true'); },
    CHRONO_JWT_SECRET:               (v) => { deepSet(env, 'jwt.secret', v); },
    CHRONO_JWT_ISSUER:               (v) => { deepSet(env, 'jwt.issuer', v); },
    CHRONO_JWT_ACCESS_TTL_MS:        (v) => { deepSet(env, 'jwt.accessTtlMs', parseInt(v, 10)); },
    CHRONO_JWT_REFRESH_TTL_MS:       (v) => { deepSet(env, 'jwt.refreshTtlMs', parseInt(v, 10)); },
    CHRONO_JWT_ALGORITHM:            (v) => { deepSet(env, 'jwt.algorithm', v); },
    CHRONO_REDIS_ENABLED:            (v) => { deepSet(env, 'redis.enabled', v === 'true'); },
    CHRONO_REDIS_URL:                (v) => { deepSet(env, 'redis.url', v); },
    CHRONO_REDIS_KEY_PREFIX:         (v) => { deepSet(env, 'redis.keyPrefix', v); },
    CHRONO_REDIS_TLS:                (v) => { deepSet(env, 'redis.tls', v === 'true'); },
    CHRONO_STRIPE_ENABLED:           (v) => { deepSet(env, 'stripe.enabled', v === 'true'); },
    CHRONO_STRIPE_SECRET_KEY:        (v) => { deepSet(env, 'stripe.secretKey', v); },
    CHRONO_STRIPE_WEBHOOK_SECRET:    (v) => { deepSet(env, 'stripe.webhookSecret', v); },
    CHRONO_STRIPE_PUBLISHABLE_KEY:   (v) => { deepSet(env, 'stripe.publishableKey', v); },
    CHRONO_BILLING_RECONCILIATION_ENABLED: (v) => { deepSet(env, 'billing.reconciliation.enabled', v === 'true'); },
    CHRONO_BILLING_RECONCILIATION_POLL_INTERVAL_MS: (v) => { deepSet(env, 'billing.reconciliation.pollIntervalMs', parseInt(v, 10)); },
    CHRONO_BILLING_RECONCILIATION_BATCH_SIZE: (v) => { deepSet(env, 'billing.reconciliation.batchSize', parseInt(v, 10)); },
    CHRONO_INTELLIGENCE_BUDGET_MONTHLY:       (v) => { deepSet(env, 'intelligence.budget.monthlyTokenLimit', parseInt(v, 10)); },
    CHRONO_INTELLIGENCE_BUDGET_DAILY:         (v) => { deepSet(env, 'intelligence.budget.dailyTokenLimit', parseInt(v, 10)); },
    CHRONO_INTELLIGENCE_BUDGET_ALERT:         (v) => { deepSet(env, 'intelligence.budget.alertThreshold', parseFloat(v)); },
    CHRONO_ENCRYPTION_ENABLED:               (v) => { deepSet(env, 'encryption.enabled', v === 'true'); },
    CHRONO_ENCRYPTION_MASTER_KEY:            (v) => { deepSet(env, 'encryption.masterKey', v); },
    CHRONO_ENCRYPTION_DEFAULT_KEY_REF:       (v) => { deepSet(env, 'encryption.defaultKeyRef', v); },
    CHRONO_ENCRYPTION_KEYRING_JSON:          (v) => { deepSet(env, 'encryption.keyring', JSON.parse(v) as Record<string, string>); },
    CHRONO_ENCRYPTION_KEY_ROTATION_DAYS:     (v) => { deepSet(env, 'encryption.keyRotationIntervalDays', parseInt(v, 10)); },
    CHRONO_SSO_ENABLED:                      (v) => { deepSet(env, 'sso.enabled', v === 'true'); },
    CHRONO_SSO_DOMAIN:                       (v) => { deepSet(env, 'sso.domain', v); },
    CHRONO_SSO_CLIENT_ID:                    (v) => { deepSet(env, 'sso.clientId', v); },
    CHRONO_SSO_CLIENT_SECRET:                (v) => { deepSet(env, 'sso.clientSecret', v); },
    CHRONO_SSO_AUDIENCE:                     (v) => { deepSet(env, 'sso.audience', v); },
    CHRONO_OIDC_ENABLED:                     (v) => { deepSet(env, 'oidc.enabled', v === 'true'); },
    CHRONO_OIDC_ISSUER_URL:                  (v) => { deepSet(env, 'oidc.issuerUrl', v); },
    CHRONO_OIDC_CLIENT_ID:                   (v) => { deepSet(env, 'oidc.clientId', v); },
    CHRONO_OIDC_CLIENT_SECRET:               (v) => { deepSet(env, 'oidc.clientSecret', v); },
    CHRONO_OIDC_AUDIENCE:                    (v) => { deepSet(env, 'oidc.audience', v); },
    CHRONO_OIDC_SCOPE:                       (v) => { deepSet(env, 'oidc.scope', v); },
    CHRONO_OIDC_EMAIL_CLAIM:                 (v) => { deepSet(env, 'oidc.emailClaim', v); },
    CHRONO_OIDC_NAME_CLAIM:                  (v) => { deepSet(env, 'oidc.nameClaim', v); },
    CHRONO_OTEL_ENABLED:             (v) => { deepSet(env, 'observability.enabled', v === 'true'); },
    CHRONO_OTEL_ENDPOINT:            (v) => { deepSet(env, 'observability.otlpEndpoint', v); },
    CHRONO_OTEL_SERVICE_NAME:        (v) => { deepSet(env, 'observability.serviceName', v); },
    CHRONO_OTEL_SERVICE_VERSION:     (v) => { deepSet(env, 'observability.serviceVersion', v); },
    CHRONO_OTEL_SAMPLE_RATE:         (v) => { deepSet(env, 'observability.sampleRate', parseFloat(v)); },
    CHRONO_OTEL_METRICS_RETENTION_MS: (v) => { deepSet(env, 'observability.metricsRetentionMs', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_WORKER_ENABLED: (v) => { deepSet(env, 'observability.worker.enabled', v === 'true'); },
    CHRONO_OBSERVABILITY_WORKER_POLL_INTERVAL_MS: (v) => { deepSet(env, 'observability.worker.pollIntervalMs', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_WORKER_BATCH_SIZE: (v) => { deepSet(env, 'observability.worker.batchSize', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_WORKER_MAX_ATTEMPTS: (v) => { deepSet(env, 'observability.worker.maxAttempts', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_WORKER_STALE_PROCESSING_MS: (v) => { deepSet(env, 'observability.worker.staleProcessingMs', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_WORKER_HTTP_ENABLED: (v) => { deepSet(env, 'observability.worker.http.enabled', v === 'true'); },
    CHRONO_OBSERVABILITY_WORKER_HTTP_HOST: (v) => { deepSet(env, 'observability.worker.http.host', v); },
    CHRONO_OBSERVABILITY_WORKER_HTTP_PORT: (v) => { deepSet(env, 'observability.worker.http.port', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_KAFKA_ENABLED: (v) => { deepSet(env, 'observability.kafka.enabled', v === 'true'); },
    CHRONO_OBSERVABILITY_KAFKA_BROKERS: (v) => { deepSet(env, 'observability.kafka.brokers', v.split(',').map((item) => item.trim()).filter(Boolean)); },
    CHRONO_OBSERVABILITY_KAFKA_CLIENT_ID: (v) => { deepSet(env, 'observability.kafka.clientId', v); },
    CHRONO_OBSERVABILITY_KAFKA_TOPIC: (v) => { deepSet(env, 'observability.kafka.topic', v); },
    CHRONO_OBSERVABILITY_KAFKA_CONSUMER_GROUP_ID: (v) => { deepSet(env, 'observability.kafka.consumerGroupId', v); },
    CHRONO_OBSERVABILITY_KAFKA_STARTUP_WAIT_MS: (v) => { deepSet(env, 'observability.kafka.startupWaitMs', parseInt(v, 10)); },
    CHRONO_OBSERVABILITY_KAFKA_SSL: (v) => { deepSet(env, 'observability.kafka.ssl', v === 'true'); },
    CHRONO_OBSERVABILITY_KAFKA_SASL_MECHANISM: (v) => { deepSet(env, 'observability.kafka.saslMechanism', v); },
    CHRONO_OBSERVABILITY_KAFKA_USERNAME: (v) => { deepSet(env, 'observability.kafka.username', v); },
    CHRONO_OBSERVABILITY_KAFKA_PASSWORD: (v) => { deepSet(env, 'observability.kafka.password', v); },
    CHRONO_AUTORUN_SCHEDULER_MS:     (v) => { deepSet(env, 'avatarAutorun.schedulerIntervalMs', parseInt(v, 10)); },
    CHRONO_AUTORUN_MAX_ITEMS:        (v) => { deepSet(env, 'avatarAutorun.maxItemsPerRun', parseInt(v, 10)); },
    CHRONO_AUTORUN_DRIFT_THRESHOLD:  (v) => { deepSet(env, 'avatarAutorun.defaultDriftThreshold', parseFloat(v)); },
    CHRONO_AUTORUN_SOURCE_TIMEOUT_MS: (v) => { deepSet(env, 'avatarAutorun.sourceTimeoutMs', parseInt(v, 10)); },
    CHRONO_OBJECT_STORAGE_PROVIDER:       (v) => { deepSet(env, 'objectStorage.provider', v); },
    CHRONO_S3_BUCKET:                     (v) => { deepSet(env, 'objectStorage.s3Bucket', v); },
    CHRONO_S3_REGION:                     (v) => { deepSet(env, 'objectStorage.s3Region', v); },
    CHRONO_S3_ENDPOINT:                   (v) => { deepSet(env, 'objectStorage.s3Endpoint', v); },
    CHRONO_S3_ACCESS_KEY_ID:              (v) => { deepSet(env, 'objectStorage.s3AccessKeyId', v); },
    CHRONO_S3_SECRET_ACCESS_KEY:          (v) => { deepSet(env, 'objectStorage.s3SecretAccessKey', v); },
    CHRONO_GCS_BUCKET:                    (v) => { deepSet(env, 'objectStorage.gcsBucket', v); },
    CHRONO_GCS_PROJECT_ID:                (v) => { deepSet(env, 'objectStorage.gcsProjectId', v); },
    CHRONO_AZURE_CONNECTION_STRING:       (v) => { deepSet(env, 'objectStorage.azureConnectionString', v); },
    CHRONO_AZURE_CONTAINER:               (v) => { deepSet(env, 'objectStorage.azureContainer', v); },
  };

  for (const [key, setter] of Object.entries(mapping)) {
    const val = process.env[key];
    if (val !== undefined) setter(val);
  }

  return env;
}

/** 深度设置嵌套对象属性 */
function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** 深度合并对象（source 覆盖 target） */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** 从配置文件加载 JSON */
function fromFile(configPath: string): Record<string, unknown> {
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 加载配置
 * 合并优先级：defaults < 配置文件 < 环境变量 < overrides
 */
/** 深度可选类型（允许嵌套对象部分覆盖，数组和基础类型保持原样） */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U extends object ? DeepPartial<U>[] : T[P]
    : T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export function loadConfig(overrides?: DeepPartial<AppConfig>, configPath?: string): AppConfig {
  let merged: Record<string, unknown> = {};

  if (configPath) {
    merged = deepMerge(merged, fromFile(configPath));
  }

  merged = deepMerge(merged, fromEnv());

  if (overrides) {
    merged = deepMerge(merged, overrides as Record<string, unknown>);
  }

  const parsed = AppConfigSchema.parse(merged);

  if (parsed.jwt.enabled && parsed.jwt.secret === 'change-me-in-production') {
    throw new Error('jwt.enabled=true 时必须设置非默认的 jwt.secret');
  }
  if (parsed.encryption.enabled && parsed.encryption.masterKey === 'change-me-in-production-32chars!') {
    throw new Error('encryption.enabled=true 时必须设置有效的 encryption.masterKey');
  }
  if (parsed.encryption.defaultKeyRef !== 'master' && !(parsed.encryption.defaultKeyRef in parsed.encryption.keyring)) {
    throw new Error('encryption.defaultKeyRef 必须为 master 或存在于 encryption.keyring');
  }
  if (parsed.stripe.enabled && (!parsed.stripe.secretKey || !parsed.stripe.webhookSecret)) {
    throw new Error('stripe.enabled=true 时必须设置 stripe.secretKey 与 stripe.webhookSecret');
  }
  if (parsed.sso.enabled && (!parsed.sso.domain || !parsed.sso.clientId || !parsed.sso.clientSecret)) {
    throw new Error('sso.enabled=true 时必须设置 sso.domain、sso.clientId、sso.clientSecret');
  }
  if (parsed.oidc.enabled && (!parsed.oidc.issuerUrl || !parsed.oidc.clientId || !parsed.oidc.clientSecret)) {
    throw new Error('oidc.enabled=true 时必须设置 oidc.issuerUrl、oidc.clientId、oidc.clientSecret');
  }
  if (parsed.sso.enabled && !parsed.server.publicUrl) {
    throw new Error('sso.enabled=true 时必须设置 server.publicUrl 作为回调基础地址');
  }
  if (parsed.oidc.enabled && !parsed.server.publicUrl) {
    throw new Error('oidc.enabled=true 时必须设置 server.publicUrl 作为回调基础地址');
  }
  if (parsed.stripe.enabled && !parsed.server.publicUrl) {
    throw new Error('stripe.enabled=true 时必须设置 server.publicUrl（用于安全重定向校验）');
  }
  if (parsed.cors.origin === true && parsed.cors.credentials) {
    throw new Error('cors.origin=true (wildcard) 不能与 credentials=true 同时使用');
  }

  return parsed;
}

/** 获取日志级别类型（用于类型安全桥接） */
export function getLogLevel(config: AppConfig): LogLevel {
  return config.log.level;
}
