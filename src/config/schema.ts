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
});

const corsSchema = z.object({
  origin: z.union([z.string(), z.array(z.string()), z.boolean()]).default(false),
  credentials: z.boolean().default(false),
});

const authSchema = z.object({
  enabled: z.boolean().default(false),
  apiKeys: z.array(z.string()).default([]),
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
}).default({
  decay: { baseLambda: 0.0001, valenceWeight: 0.3, accessBoost: 0.5, kindFactors: { episodic: 1.0, semantic: 0.5, procedural: 0.3 } },
  activation: { baseActivation: 0.1, damping: 0.5, maxDepth: 2 },
  workingMemory: { capacity: 7, recencyDecay: 0.0001 },
  consolidation: { accessThreshold: 5, minSalience: 0.3 },
});

const intelligenceSimulationSchema = z.object({
  rollouts: z.coerce.number().int().min(1).max(10).default(3),
  maxOptions: z.coerce.number().int().min(2).max(6).default(4),
}).default({ rollouts: 3, maxOptions: 4 });

const intelligenceSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'ollama', 'mock']).default('mock'),
  model: z.string().default('claude-sonnet-4-5-20250929'),
  embeddingModel: z.string().default('text-embedding-3-small'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  maxTokens: z.coerce.number().int().default(4096),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  simulation: intelligenceSimulationSchema,
});

const onboardingSchema = z.object({
  predefinedValues: z.array(z.string()).default([
    '好奇心', '诚信', '稳定', '成长', '同理心',
    '自律', '创造力', '自由', '影响力', '学习',
    '健康', '家庭', '社区', '勇气', '专注',
    '平衡', '诚实', '坚韧', '创新', '精通',
  ]),
  maxImportEntries: z.coerce.number().int().min(1).default(100),
});

const queueSchema = z.object({
  enabled: z.boolean().default(false),
  pollIntervalMs: z.coerce.number().int().min(100).default(1000),
  maxConcurrent: z.coerce.number().int().min(1).default(2),
  maxRetries: z.coerce.number().int().min(0).default(3),
});

const requestSchema = z.object({
  timeoutMs: z.coerce.number().int().min(0).default(30_000),
  maxBodyBytes: z.coerce.number().int().min(1024).default(1_048_576),
});

export const AppConfigSchema = z.object({
  db: dbSchema.default({ driver: 'sqlite', path: ':memory:', pool: { max: 10, idleTimeoutMs: 30_000 } }),
  log: logSchema.default({ level: 'info', json: false }),
  server: serverSchema.default({ host: '0.0.0.0', port: 3000 }),
  integration: integrationSchema.default({ fitnessThreshold: 0.6, confidenceThreshold: 0.5 }),
  rateLimit: rateLimitSchema.default({ max: 100, timeWindowMs: 60_000 }),
  websocket: websocketSchema.default({ enabled: true, heartbeatIntervalMs: 30_000 }),
  cors: corsSchema.default({ origin: false, credentials: false }),
  auth: authSchema.default({ enabled: false, apiKeys: [] }),
  intelligence: intelligenceSchema.default({
    provider: 'mock', model: 'claude-sonnet-4-5-20250929', embeddingModel: 'text-embedding-3-small',
    maxTokens: 4096, temperature: 0.7, simulation: { rollouts: 3, maxOptions: 4 },
  }),
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
  queue: queueSchema.default({ enabled: false, pollIntervalMs: 1000, maxConcurrent: 2, maxRetries: 3 }),
  cognition: cognitionSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/** 从环境变量读取配置（CHRONO_ 前缀） */
function fromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  const mapping: Record<string, (val: string) => void> = {
    CHRONO_DB_DRIVER:               (v) => { deepSet(env, 'db.driver', v); },
    CHRONO_DB_PATH:                 (v) => { deepSet(env, 'db.path', v); },
    CHRONO_DB_CONNECTION_STRING:    (v) => { deepSet(env, 'db.connectionString', v); },
    CHRONO_DB_POOL_MAX:             (v) => { deepSet(env, 'db.pool.max', parseInt(v, 10)); },
    CHRONO_DB_POOL_IDLE_TIMEOUT_MS: (v) => { deepSet(env, 'db.pool.idleTimeoutMs', parseInt(v, 10)); },
    CHRONO_LOG_LEVEL:               (v) => { deepSet(env, 'log.level', v); },
    CHRONO_LOG_JSON:                (v) => { deepSet(env, 'log.json', v === 'true'); },
    CHRONO_SERVER_HOST:             (v) => { deepSet(env, 'server.host', v); },
    CHRONO_SERVER_PORT:             (v) => { deepSet(env, 'server.port', parseInt(v, 10)); },
    CHRONO_INTEGRATION_FITNESS:     (v) => { deepSet(env, 'integration.fitnessThreshold', parseFloat(v)); },
    CHRONO_INTEGRATION_CONFIDENCE:  (v) => { deepSet(env, 'integration.confidenceThreshold', parseFloat(v)); },
    CHRONO_RATE_LIMIT_MAX:          (v) => { deepSet(env, 'rateLimit.max', parseInt(v, 10)); },
    CHRONO_RATE_LIMIT_WINDOW_MS:    (v) => { deepSet(env, 'rateLimit.timeWindowMs', parseInt(v, 10)); },
    CHRONO_WEBSOCKET_ENABLED:       (v) => { deepSet(env, 'websocket.enabled', v === 'true'); },
    CHRONO_WEBSOCKET_HEARTBEAT_MS:  (v) => { deepSet(env, 'websocket.heartbeatIntervalMs', parseInt(v, 10)); },
    CHRONO_CORS_ORIGIN:             (v) => { deepSet(env, 'cors.origin', v === 'true' ? true : v === 'false' ? false : v); },
    CHRONO_CORS_CREDENTIALS:        (v) => { deepSet(env, 'cors.credentials', v === 'true'); },
    CHRONO_AUTH_ENABLED:            (v) => { deepSet(env, 'auth.enabled', v === 'true'); },
    CHRONO_AUTH_API_KEYS:           (v) => { deepSet(env, 'auth.apiKeys', v.split(',')); },
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
    CHRONO_QUEUE_ENABLED:            (v) => { deepSet(env, 'queue.enabled', v === 'true'); },
    CHRONO_QUEUE_POLL_INTERVAL_MS:   (v) => { deepSet(env, 'queue.pollIntervalMs', parseInt(v, 10)); },
    CHRONO_QUEUE_MAX_CONCURRENT:     (v) => { deepSet(env, 'queue.maxConcurrent', parseInt(v, 10)); },
    CHRONO_QUEUE_MAX_RETRIES:        (v) => { deepSet(env, 'queue.maxRetries', parseInt(v, 10)); },
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

  return AppConfigSchema.parse(merged);
}

/** 获取日志级别类型（用于类型安全桥接） */
export function getLogLevel(config: AppConfig): LogLevel {
  return config.log.level;
}
