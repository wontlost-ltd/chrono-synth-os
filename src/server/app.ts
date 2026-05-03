/**
 * Fastify 应用工厂
 * 创建并配置 Fastify 实例，注册所有路由和插件
 */

import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { PinoLogger } from '../logging/pino-logger.js';
import type { IDatabase } from '../storage/database.js';
import { buildAppServices } from './app-services.js';
import type { AppConfig } from '../config/schema.js';
import { NodeEventPublisher } from '../events/node-event-publisher.js';
import { NodeUnitOfWorkFactory } from '../storage/node-unit-of-work.js';
import type { UnitOfWorkFactory } from '@chrono/kernel';
import type { FieldCrypto } from '@chrono/data-plane';
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
import { registerIdempotency } from './plugins/idempotency.js';
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
import { registerOidcRoutes } from './routes/auth-oidc.js';
import { cleanupExpiredTokens } from './routes/auth.js';
import { registerAuth0 } from './plugins/auth0.js';
import { registerCollaborationRoutes } from './routes/collaboration.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerAdminConfigRoutes } from './routes/admin-config.js';
import { registerAdminDeploymentRoutes } from './routes/admin-deployment.js';
import { registerAdminControlPlaneRoutes } from './routes/admin-control-plane.js';
import { registerMobileRoutes } from './routes/mobile.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerUserRoutes } from './routes/users.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerAvatarAutorunRoutes } from './routes/avatar-autorun.js';
import { registerKnowledgeSourceRoutes } from './routes/knowledge-sources.js';
import { registerPersonaCoreRoutes } from './routes/persona-core.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerScimRoutes } from './routes/scim.js';
import { registerV2Routes } from './routes/v2/index.js';
import { TaskQueue } from '../queue/task-queue.js';
import { TaskWorker } from '../queue/task-worker.js';
import { BillingOutbox } from '../billing/billing-outbox.js';
import { SettlementReconciliationWorker } from '../billing/settlement-reconciliation-worker.js';
import { ObservabilityPipelineService } from '../observability/observability-pipeline-service.js';
import { RuntimeRecoveryWorker } from '../persona-core/runtime-recovery-worker.js';
import { AvatarAutorunStore } from '../storage/avatar-autorun-store.js';
import { KnowledgeSourceStore } from '../storage/knowledge-source-store.js';
import { AvatarService } from '../identity/avatar-service.js';
import { AvatarAutorunService } from '../identity/avatar-autorun-service.js';
import { KnowledgeIngestionService } from '../knowledge/knowledge-ingestion-service.js';
import { KnowledgeSourceRegistry } from '../knowledge/knowledge-source-registry.js';
import { ManualKnowledgeSource } from '../knowledge/sources/manual-source.js';
import { RssKnowledgeSource } from '../knowledge/sources/rss-source.js';
import { ApiKnowledgeSource } from '../knowledge/sources/api-source.js';
import { FileKnowledgeSource } from '../knowledge/sources/file-source.js';
import { LlmKnowledgeSource } from '../knowledge/sources/llm-source.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';
import { ModelRouter } from '../intelligence/model-router.js';
import type { SqlValue } from '../storage/database.js';

export interface CreateAppDeps {
  os: ChronoSynthOS;
  logger?: PinoLogger;
  config?: AppConfig;
  db?: IDatabase;
  circuitBreaker?: CircuitBreaker;
  /** 异步 UnitOfWorkFactory（P0-1 过渡）：新服务优先使用，旧服务继续使用 db */
  uowFactory?: UnitOfWorkFactory;
  fieldCrypto?: FieldCrypto;
}

export async function createApp(deps: CreateAppDeps): Promise<FastifyInstance> {
  const config = deps.config ?? loadConfig();

  /* SQLite 多副本安全检查 */
  if (config.db.driver === 'sqlite' && process.env.REPLICA_COUNT && Number(process.env.REPLICA_COUNT) > 1) {
    const msg = `SQLite 不支持多写入器。当前 REPLICA_COUNT=${process.env.REPLICA_COUNT}，请切换到 Postgres (db.driver='postgres') 后再部署多副本。`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    console.warn(`[WARN] ${msg}`);
  }

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
  registerAuth(app, config, deps.db);
  registerAuditLog(app, deps.db);
  registerObservability(app, config);

  /* 异步插件 */
  await registerJwtAuth(app, config);
  registerTenantHook(app);  /* 在 JWT 之后注册，确保 request.user 已填充 */
  registerIdempotency(app, deps.db ?? deps.os.getDatabase(), config);
  await registerAuth0(app, config);
  await registerRedis(app, config);
  await registerCors(app, config);
  await registerHelmet(app);
  await registerRateLimit(app, config);
  await registerWebSocket(app, deps.os, config);

  /* 全局处理空 JSON body：前端 POST 可能不带 body 但设置了 Content-Type: application/json */
  app.addHook('preParsing', async (request, _reply, payload) => {
    const ct = request.headers['content-type'];
    const cl = request.headers['content-length'];
    if (ct && ct.includes('application/json') && (cl === '0' || (!cl && !request.headers['transfer-encoding']))) {
      request.headers['content-length'] = '2';
      return Readable.from(Buffer.from('{}'));
    }
    return payload;
  });

  /* 错误处理（在路由之前注册，以捕获路由中的错误） */
  registerErrorHandler(app);

  /* 多租户 OS 工厂 */
  const db = deps.db ?? deps.os.getDatabase();
  const uowFactory: UnitOfWorkFactory = deps.uowFactory
    ?? new NodeUnitOfWorkFactory(db, new NodeEventPublisher());
  const services = buildAppServices(db, config, deps.logger);
  const tenantFactory = new TenantOSFactory(
    db,
    deps.os.getClock(),
    deps.os.getLogger(),
    undefined,
    deps.config?.encryption,
  );
  app.addHook('onClose', () => { tenantFactory.clear(); });

  let observabilityWorker: ObservabilityPipelineService | undefined;
  let runtimeRecoveryWorker: RuntimeRecoveryWorker | undefined;
  let settlementReconciliationWorker: SettlementReconciliationWorker | undefined;
  if (config.observability.worker.enabled) {
    observabilityWorker = new ObservabilityPipelineService(
      db,
      deps.os.getLogger(),
      config.observability,
    );
    await observabilityWorker.start();
    app.addHook('onClose', async () => { await observabilityWorker!.stop(); });
  }

  if (config.runtime.recovery.enabled) {
    runtimeRecoveryWorker = new RuntimeRecoveryWorker(
      db,
      deps.os.getLogger(),
      {
        pollIntervalMs: config.runtime.recovery.pollIntervalMs,
        sessionTimeoutMs: config.runtime.recovery.sessionTimeoutMs,
        maxRetries: config.runtime.recovery.maxRetries,
        batchSize: config.runtime.recovery.batchSize,
      },
    );
    runtimeRecoveryWorker.start();
    app.addHook('onClose', async () => { await runtimeRecoveryWorker!.stop(); });
  }

  if (config.billing.reconciliation.enabled) {
    settlementReconciliationWorker = new SettlementReconciliationWorker(
      db,
      deps.os.getLogger(),
      {
        pollIntervalMs: config.billing.reconciliation.pollIntervalMs,
        batchSize: config.billing.reconciliation.batchSize,
      },
    );
    settlementReconciliationWorker.start();
    app.addHook('onClose', async () => { await settlementReconciliationWorker!.stop(); });
  }

  /* 任务队列（提前创建以便注入健康路由） */
  let worker: TaskWorker | undefined;
  if (config.queue.enabled) {
    const queueDb = deps.db ?? deps.os.getDatabase();
    const queue = new TaskQueue(queueDb, undefined, {
      maxPendingPerTenant: config.queue.maxPendingPerTenant,
      completedRetentionMs: config.queue.completedRetentionMs,
    });
    worker = new TaskWorker(
      queue,
      deps.os.bus,
      deps.os.getLogger(),
      config.queue.pollIntervalMs,
      config.queue.maxConcurrent,
      config.queue.maxRetries,
    );
    registerTaskRoutes(app, queue, worker, queueDb);
    worker.register('life_simulation', async (task, _signal) => {
      let payload: { simulationId: string };
      try { payload = JSON.parse(task.payload) as { simulationId: string }; }
      catch { throw new Error(`任务 ${task.id} payload 解析失败`); }
      deps.os.lifeSimulation.executeTask(payload.simulationId);
    }, 180_000);

    /* Avatar 自动运行 handler */
    const autorunStore = new AvatarAutorunStore(queueDb);
    const knowledgeStore = new KnowledgeSourceStore(queueDb);
    const avatarService = new AvatarService(queueDb);
    const quotaManager = new QuotaManager(queueDb);
    const knowledgeRegistry = new KnowledgeSourceRegistry();
    knowledgeRegistry.register('manual', new ManualKnowledgeSource());
    knowledgeRegistry.register('rss', new RssKnowledgeSource());
    knowledgeRegistry.register('api', new ApiKnowledgeSource());
    knowledgeRegistry.register('file', new FileKnowledgeSource());
    const llmRouter = new ModelRouter({
      provider: config.intelligence.provider,
      model: config.intelligence.model,
      embeddingModel: config.intelligence.embeddingModel,
      apiKey: config.intelligence.apiKey,
      baseUrl: config.intelligence.baseUrl,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
    });
    knowledgeRegistry.register('llm', new LlmKnowledgeSource(llmRouter));

    const knowledgeIngestion = new KnowledgeIngestionService(
      knowledgeRegistry, knowledgeStore, deps.os.core.memories,
      undefined, deps.os.bus, deps.os.getLogger(),
      config.avatarAutorun.maxItemsPerRun,
    );

    const autorunService = new AvatarAutorunService(
      queueDb, queue, deps.os.bus, deps.os.getLogger(),
      quotaManager, avatarService, autorunStore, knowledgeStore,
      knowledgeIngestion, tenantFactory, config,
    );

    worker.register('avatar_autorun', async (task, signal) => {
      let payload: { runId: string; configId: string };
      try { payload = JSON.parse(task.payload) as { runId: string; configId: string }; }
      catch { throw new Error(`任务 ${task.id} payload 解析失败`); }
      await autorunService.executeRun(payload.runId, signal);
    }, 300_000);

    /* 自动运行调度器 */
    const autorunSchedulerTimer = setInterval(() => {
      try { autorunService.scheduleDueRuns(Date.now()); }
      catch (err) { app.log.error({ err }, 'Avatar 自动运行调度器异常'); }
    }, config.avatarAutorun.schedulerIntervalMs);
    autorunSchedulerTimer.unref();
    app.addHook('onClose', () => { clearInterval(autorunSchedulerTimer); });

    /* 注册自动运行路由（需 autorunService） */
    registerAvatarAutorunRoutes(app, queueDb, autorunService);

    worker.start();
    app.addHook('onClose', async () => { await worker!.stop(); });
  }

  /* 路由 */
  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, services);
  registerOrganizationRoutes(app, services);
  registerBillingRoutes(app, db, config);
  registerPersonaCoreRoutes(app, db, config);
  registerHealthRoutes(app, {
    os: deps.os,
    db: deps.db,
    circuitBreaker: deps.circuitBreaker,
    worker,
    observabilityWorker,
    runtimeRecoveryWorker,
    settlementReconciliationWorker,
  });
  registerValueRoutes(app, deps.os, tenantFactory);
  registerMemoryRoutes(app, deps.os, tenantFactory, config);
  registerNarrativeRoutes(app, deps.os, tenantFactory);
  registerPersonaRoutes(app, deps.os, tenantFactory);
  registerSnapshotRoutes(app, deps.os, tenantFactory);
  registerOperationRoutes(app, deps.os, tenantFactory);
  registerConflictRoutes(app, db, config);
  registerMetricsRoutes(app, deps.os, config);
  registerAuditRoutes(app, db);
  registerPosRoutes(app, deps.os, tenantFactory);
  registerDecisionRoutes(app, deps.os, config, db, tenantFactory);
  registerOnboardingRoutes(app, deps.os, config, db, tenantFactory);
  registerVisualizationRoutes(app, deps.os, tenantFactory);
  registerPrivacyRoutes(app, deps.os, tenantFactory, config);
  registerLifeSimulationRoutes(app, deps.os.lifeSimulation, { queueEnabled: config.queue.enabled, db, config });
  registerLifeSimVizRoutes(app, deps.os.lifeSimulation);
  registerSsoRoutes(app, db, config);
  registerOidcRoutes(app, db, config);
  registerScimRoutes(app, db, config);
  registerCollaborationRoutes(app, services);
  registerApiKeyRoutes(app, services);
  registerAdminConfigRoutes(app, db, config);
  registerAdminDeploymentRoutes(app, db, config);
  registerAdminControlPlaneRoutes(app, services);
  registerMobileRoutes(app, services);
  registerIdentityRoutes(app, services);
  registerAvatarRoutes(app, db, deps.os, tenantFactory);
  registerKnowledgeSourceRoutes(app, services);
  registerSseRoutes(app, deps.os, config);
  registerV2Routes(app, db, config, uowFactory);

  /* 队列未启用时仍注册自动运行路由（autorunService=undefined，手动触发将返回提示） */
  if (!config.queue.enabled) {
    registerAvatarAutorunRoutes(app, db, undefined);
  }

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

  /* 定期清理过期数据（每 6 小时：usage_records 90 天、billing_outbox 30 天、webhook_events 7 天） */
  const DATA_RETENTION_INTERVAL = 6 * 60 * 60 * 1000;
  const RETENTION_BATCH_SIZE = 5000;
  const retentionTimer = setInterval(() => {
    const now = Date.now();
    const log = deps.os.getLogger();
    const pruneTable = (table: string, pkColumn: string, whereClause: string, ...params: SqlValue[]) => {
      try {
        let total = 0;
        /* 批量删除：先 SELECT 主键再 DELETE，兼容 SQLite 和 PostgreSQL */
        while (true) {
          const ids = db.prepare<{ pk: SqlValue }>(
            `SELECT ${pkColumn} AS pk FROM ${table} WHERE ${whereClause} LIMIT ${RETENTION_BATCH_SIZE}`,
          ).all(...params);
          if (ids.length === 0) break;
          const placeholders = ids.map(() => '?').join(',');
          db.prepare<void>(
            `DELETE FROM ${table} WHERE ${pkColumn} IN (${placeholders})`,
          ).run(...ids.map(r => r.pk));
          total += ids.length;
          if (ids.length < RETENTION_BATCH_SIZE) break;
        }
        if (total > 0) log.info('Retention', `清理 ${table}: 删除 ${total} 行`);
      } catch { /* 表可能不存在 */ }
    };
    pruneTable('usage_records', 'id', 'recorded_at < ?', now - 90 * 24 * 60 * 60 * 1000);
    pruneTable('billing_outbox', 'id', 'status = ? AND processed_at < ?', 'sent', now - 30 * 24 * 60 * 60 * 1000);
    pruneTable('webhook_events', 'event_id', 'processed_at < ?', now - 7 * 24 * 60 * 60 * 1000);
    pruneTable('idempotency_keys', 'id', 'expires_at < ?', now);
  }, DATA_RETENTION_INTERVAL);
  retentionTimer.unref();
  app.addHook('onClose', () => { clearInterval(retentionTimer); });

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
