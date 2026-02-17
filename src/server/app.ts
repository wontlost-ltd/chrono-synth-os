/**
 * Fastify 应用工厂
 * 创建并配置 Fastify 实例，注册所有路由和插件
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { PinoLogger } from '../logging/pino-logger.js';
import type { IDatabase } from '../storage/database.js';
import type { AppConfig } from '../config/schema.js';
import { loadConfig } from '../config/schema.js';
import type { CircuitBreaker } from './plugins/circuit-breaker.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerRequestId } from './plugins/request-id.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerWebSocket } from './plugins/websocket.js';
import { registerCors } from './plugins/cors.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerAuth } from './plugins/auth.js';
import { registerAuditLog } from './plugins/audit-log.js';
import { registerRequestTimeout } from './plugins/request-timeout.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerValueRoutes } from './routes/values.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerNarrativeRoutes } from './routes/narrative.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerConflictRoutes } from './routes/conflicts.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerPosRoutes } from './routes/pos.js';

export interface CreateAppDeps {
  os: ChronoSynthOS;
  logger?: PinoLogger;
  config?: AppConfig;
  /** 数据库实例，用于审计日志和健康检查（可选） */
  db?: IDatabase;
  /** 断路器实例，用于健康检查（可选，便于测试注入） */
  circuitBreaker?: CircuitBreaker;
}

export async function createApp(deps: CreateAppDeps): Promise<FastifyInstance> {
  const config = deps.config ?? loadConfig();

  const app: FastifyInstance = deps.logger
    ? Fastify({ loggerInstance: deps.logger.pino, bodyLimit: config.request.maxBodyBytes }) as unknown as FastifyInstance
    : Fastify({ logger: false, bodyLimit: config.request.maxBodyBytes });

  /* 同步插件 */
  registerRequestId(app);
  registerMetrics(app);
  registerRequestTimeout(app, config);
  registerAuth(app, config);
  registerAuditLog(app, deps.db);

  /* 异步插件 */
  await registerCors(app, config);
  await registerHelmet(app);
  await registerRateLimit(app, config);
  await registerWebSocket(app, deps.os, config);

  /* 错误处理（在路由之前注册，以捕获路由中的错误） */
  registerErrorHandler(app);

  /* 路由 */
  registerHealthRoutes(app, { os: deps.os, db: deps.db, circuitBreaker: deps.circuitBreaker });
  registerValueRoutes(app, deps.os);
  registerMemoryRoutes(app, deps.os);
  registerNarrativeRoutes(app, deps.os);
  registerPersonaRoutes(app, deps.os);
  registerSnapshotRoutes(app, deps.os);
  registerOperationRoutes(app, deps.os);
  registerConflictRoutes(app, deps.os);
  registerMetricsRoutes(app, deps.os);
  registerAuditRoutes(app, deps.db);
  registerPosRoutes(app, deps.os);
  registerDocsRoutes(app);

  return app;
}
