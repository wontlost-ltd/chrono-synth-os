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
import { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerRequestId } from './plugins/request-id.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerWebSocket } from './plugins/websocket.js';
import { registerCors } from './plugins/cors.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerAuth } from './plugins/auth.js';
import { registerJwtAuth } from './plugins/jwt-auth.js';
import { registerRedis } from './plugins/redis.js';
import { registerTenantDecorator, registerTenantHook } from './plugins/tenant.js';
import { registerAuditLog } from './plugins/audit-log.js';
import { registerRequestTimeout } from './plugins/request-timeout.js';
import { registerObservability } from './plugins/observability.js';
import { registerRequestLogContext } from './plugins/request-log-context.js';
import { registerApiVersion } from './plugins/api-version.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
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
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerVisualizationRoutes } from './routes/visualization.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerLifeSimulationRoutes } from './routes/life-simulations.js';
import { registerLifeSimVizRoutes } from './routes/life-simulation-viz.js';
import { registerSsoRoutes } from './routes/auth-sso.js';
import { cleanupExpiredTokens } from './routes/auth.js';
import { registerAuth0 } from './plugins/auth0.js';
import { registerCollaborationRoutes } from './routes/collaboration.js';
import { TaskQueue } from '../queue/task-queue.js';
import { TaskWorker } from '../queue/task-worker.js';
import { BillingOutbox } from '../billing/billing-outbox.js';

export interface CreateAppDeps {
  os: ChronoSynthOS;
  logger?: PinoLogger;
  config?: AppConfig;
  db?: IDatabase;
  circuitBreaker?: CircuitBreaker;
}

export async function createApp(deps: CreateAppDeps): Promise<FastifyInstance> {
  const config = deps.config ?? loadConfig();

  const app: FastifyInstance = deps.logger
    ? Fastify({ loggerInstance: deps.logger.pino, bodyLimit: config.request.maxBodyBytes }) as unknown as FastifyInstance
    : Fastify({ logger: false, bodyLimit: config.request.maxBodyBytes });

  /* 同步插件 */
  registerRequestId(app);
  registerTenantDecorator(app);  /* 仅注册装饰器，hook 延迟到 JWT 之后 */
  registerRequestLogContext(app);
  registerApiVersion(app);
  registerMetrics(app);
  registerRequestTimeout(app, config);
  registerAuth(app, config);
  registerAuditLog(app, deps.db);
  registerObservability(app, config);

  /* 异步插件 */
  await registerJwtAuth(app, config);
  registerTenantHook(app);  /* 在 JWT 之后注册，确保 request.user 已填充 */
  await registerAuth0(app, config);
  await registerRedis(app, config);
  await registerCors(app, config);
  await registerHelmet(app);
  await registerRateLimit(app, config);
  await registerWebSocket(app, deps.os, config);

  /* 错误处理（在路由之前注册，以捕获路由中的错误） */
  registerErrorHandler(app);

  /* 多租户 OS 工厂 */
  const db = deps.db ?? deps.os.getDatabase();
  const tenantFactory = new TenantOSFactory(
    db,
    deps.os.getClock(),
    deps.os.getLogger(),
    undefined,
    deps.config?.encryption,
  );
  app.addHook('onClose', () => { tenantFactory.clear(); });

  /* 任务队列（提前创建以便注入健康路由） */
  let worker: TaskWorker | undefined;
  if (config.queue.enabled) {
    const queueDb = deps.db ?? deps.os.getDatabase();
    const queue = new TaskQueue(queueDb);
    registerTaskRoutes(app, queue);
    worker = new TaskWorker(
      queue,
      deps.os.bus,
      deps.os.getLogger(),
      config.queue.pollIntervalMs,
      config.queue.maxConcurrent,
      config.queue.maxRetries,
    );
    worker.register('life_simulation', async (task) => {
      let payload: { simulationId: string };
      try { payload = JSON.parse(task.payload) as { simulationId: string }; }
      catch { throw new Error(`任务 ${task.id} payload 解析失败`); }
      deps.os.lifeSimulation.executeTask(payload.simulationId);
    });
    worker.start();
    app.addHook('onClose', async () => { await worker!.stop(); });
  }

  /* 路由 */
  registerAuthRoutes(app, db, config);
  registerBillingRoutes(app, db, config);
  registerHealthRoutes(app, { os: deps.os, db: deps.db, circuitBreaker: deps.circuitBreaker, worker });
  registerValueRoutes(app, deps.os, tenantFactory);
  registerMemoryRoutes(app, deps.os, tenantFactory, config);
  registerNarrativeRoutes(app, deps.os, tenantFactory);
  registerPersonaRoutes(app, deps.os, tenantFactory);
  registerSnapshotRoutes(app, deps.os, tenantFactory);
  registerOperationRoutes(app, deps.os, tenantFactory);
  registerConflictRoutes(app, deps.os, tenantFactory);
  registerMetricsRoutes(app, deps.os);
  registerAuditRoutes(app, deps.db);
  registerPosRoutes(app, deps.os, tenantFactory);
  registerDecisionRoutes(app, deps.os, config, db, tenantFactory);
  registerOnboardingRoutes(app, deps.os, config, db, tenantFactory);
  registerVisualizationRoutes(app, deps.os, tenantFactory);
  registerPrivacyRoutes(app, deps.os, tenantFactory);
  registerLifeSimulationRoutes(app, deps.os.lifeSimulation, { queueEnabled: config.queue.enabled, db, config });
  registerLifeSimVizRoutes(app, deps.os.lifeSimulation);
  registerSsoRoutes(app, db, config);
  registerCollaborationRoutes(app, db);

  registerDocsRoutes(app);

  /* 定期清理过期刷新令牌（每 24 小时） */
  if (config.jwt.enabled) {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
    const cleanupTimer = setInterval(() => {
      try { cleanupExpiredTokens(db); } catch { /* 清理失败不影响服务 */ }
    }, CLEANUP_INTERVAL);
    cleanupTimer.unref();
    app.addHook('onClose', () => { clearInterval(cleanupTimer); });
  }

  /* 定期刷新 Stripe 计量发件箱（每 60 秒） */
  if (config.stripe.enabled) {
    const billingOutbox = new BillingOutbox(db, config);
    const FLUSH_INTERVAL_MS = 60_000;
    const flushTimer = setInterval(() => {
      void billingOutbox.flush().catch((err) => {
        deps.os.getLogger().warn('Billing', `计量发件箱刷新失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();
    app.addHook('onClose', () => { clearInterval(flushTimer); });
  }

  return app;
}
