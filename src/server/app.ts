/**
 * Fastify 应用工厂
 * 创建并配置 Fastify 实例，注册所有路由和插件
 */

import './fastify-augmentation.js';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { PinoLogger } from '../logging/pino-logger.js';
import type { IDatabase } from '../storage/database.js';
import { buildAppServices } from './app-services.js';
import { NudgePushBridge } from './services/nudge-push-bridge.js';
import type { AppConfig } from '../config/schema.js';
import { NodeEventPublisher } from '../events/node-event-publisher.js';
import { NodeUnitOfWorkFactory } from '../storage/node-unit-of-work.js';
import type { UnitOfWorkFactory } from '@chrono/kernel';
import type { FieldCrypto } from '@chrono/data-plane';
import { loadConfig, intelligenceProvidesEmbeddings } from '../config/schema.js';
import type { CircuitBreaker } from './plugins/circuit-breaker.js';
import { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerA11yHeaders } from './plugins/a11y-headers.js';
import { registerRequestId } from './plugins/request-id.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerWebSocket } from './plugins/websocket.js';
import { registerCors } from './plugins/cors.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerAuth } from './plugins/auth.js';
import { registerCsrf } from './plugins/csrf.js';
import { registerJwtAuth } from './plugins/jwt-auth.js';
import { JwtKeyStore } from './plugins/jwt-key-store.js';
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
import { registerCompanionRoutes } from './routes/companion/me.js';
import { registerCompanionPerceiveRoutes } from './routes/companion/perceive.js';
import { registerCompanionPerceiveStreamRoutes } from './routes/companion/perceive-stream.js';
import { registerCompanionEnvironmentRoutes } from './routes/companion/environment.js';
import { registerCompanionChatRoutes } from './routes/companion/chat.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerConflictRoutes } from './routes/conflicts.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerDashboardRoutes } from './routes/dashboards.js';
import { registerPosRoutes } from './routes/pos.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerOnboardingV2Routes } from './routes/onboarding-v2.js';
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
import { registerAdminTemplateRoutes } from './routes/admin-templates.js';
import { registerAdminToolsRoutes } from './routes/admin-tools.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { ToolPermissionService } from '../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../agent/agency-authorization-service.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { ToolInvocationPipeline } from '../agent/tool-invocation-pipeline.js';
import { PersonaContextTool } from '../agent/tools/persona-context-tool.js';
import { MemorySearchTool } from '../agent/tools/memory-search-tool.js';
import { MemoryAddTool } from '../agent/tools/memory-add-tool.js';
import { KnowledgeQueryTool } from '../agent/tools/knowledge-query-tool.js';
import { DecisionRecordTool } from '../agent/tools/decision-record-tool.js';
import { MarketplaceTool } from '../agent/tools/marketplace-tool.js';
import { WebSearchTool } from '../agent/tools/web-search-tool.js';
import { CalendarTool } from '../agent/tools/calendar-tool.js';
import { EmailTool } from '../agent/tools/email-tool.js';
import { ChronoMcpServer } from '../mcp/chrono-mcp-server.js';
import { UserOauthTokenService, IdentityEncryption, type TokenEncryption } from '../agent/user-oauth-token-service.js';
import { GoogleOauthFlow } from '../agent/oauth-google-flow.js';
import { registerAgentOauthRoutes } from './routes/agent-oauth.js';
import { registerAgentConfirmationsRoutes } from './routes/agent-confirmations.js';
import { createUserOauthTokenResolverFactory } from './agent-oauth-resolver.js';
import { ToolInvocationsRetentionWorker } from '../agent/tool-invocations-retention-worker.js';
import { registerBulkKnowledgeImportRoutes } from './routes/bulk-knowledge-import.js';
import { BulkImportService } from '../knowledge/bulk-import-service.js';
import { UrlContentFetcher } from '../knowledge/url-content-fetcher.js';
import { registerBulkImportHandler } from '../knowledge/bulk-import-worker.js';
import { PersonaCoreService } from '../persona-core/persona-core-service.js';
import { PersonaTemplateService } from '../enterprise/persona-template-service.js';
import { ConversationService } from '../conversation/conversation-service.js';
import { ConversationRetentionWorker } from '../conversation/conversation-retention-worker.js';
import { registerConversationRoutes } from './routes/conversation.js';
import { registerDistillationRoutes } from './routes/distillation.js';
import { CircuitBreaker as ConversationCircuitBreaker } from './plugins/circuit-breaker.js';
import { FieldEncryption as ConversationFieldEncryption } from '../storage/encryption.js';
import { resolveLlmApiKeyAtStartup, tryByokEncryption } from '../storage/llm-credential-store.js';
import { resolveTargetValueForCategory } from '../intelligence/earning-value-resolver.js';
import { TokenBudget as ConversationTokenBudget } from '../intelligence/token-budget.js';
import { CostTracker as ConversationCostTracker } from '../intelligence/cost-tracker.js';
import { UsageTracker as P1dUsageTracker } from '../billing/usage-tracker.js';
import { BillingOutbox as P1dBillingOutbox } from '../billing/billing-outbox.js';
import { SubscriptionGateService } from '../billing/subscription-gate-service.js';
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
import { registerFeatureFlagRoutes } from './routes/feature-flags.js';
import { registerScimRoutes } from './routes/scim.js';
import { registerV2Routes } from './routes/v2/index.js';
import { TaskQueue } from '../queue/task-queue.js';
import { TaskWorker } from '../queue/task-worker.js';
import { BillingOutbox } from '../billing/billing-outbox.js';
import { SettlementReconciliationWorker } from '../billing/settlement-reconciliation-worker.js';
import { ObservabilityPipelineService } from '../observability/observability-pipeline-service.js';
import { RuntimeRecoveryWorker } from '../persona-core/runtime-recovery-worker.js';
import { DualWriteFlushWorker } from '../workers/dual-write-flush-worker.js';
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
import { QuotaUsageRetentionWorker } from '../multi-tenant/quota-usage-retention-worker.js';
import { ModelRouter } from '../intelligence/model-router.js';
import { DecisionEngine } from '../intelligence/decision-engine.js';
import { RuleEngine } from '../intelligence/rule-engine.js';
import { RetrievalService } from '../intelligence/retrieval-service.js';
import { InMemoryEmbeddingIndex } from '../intelligence/embedding-index-memory.js';
import { PersonaEarningService } from '../intelligence/persona-earning-service.js';
import { registerEarningRoutes } from './routes/earning.js';
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

  /* loggerInstance with a custom pino instance produces
   * FastifyInstance<..., Logger<never, boolean>> which TS won't unify with
   * the FastifyBaseLogger-parameterised default. The runtime API is
   * identical; cast at the boundary. */
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
  /* P0-D #2: 注入 jwt_signing_keys 持久化层。若 config 配了
   * encryption.enabled=true，则私钥/对称密钥落库前用 FieldEncryption
   * 加密；否则降级为明文（带 lint:field-encryption 警告）。 */
  const jwtKeyStoreDb = deps.db ?? deps.os.getDatabase();
  const jwtFieldCrypto = config.encryption.enabled
    ? new ConversationFieldEncryption(config.encryption)
    : undefined;
  const jwtKeyStoreOptions: { fieldCrypto?: ConversationFieldEncryption; keyRef?: string } = {};
  if (jwtFieldCrypto) {
    jwtKeyStoreOptions.fieldCrypto = jwtFieldCrypto;
    /* 用配置中的 defaultKeyRef（默认 'master'），让 jwt_signing_keys
     * 的密文与平台 keyring rotation 周期对齐。 */
    if (config.encryption.defaultKeyRef) jwtKeyStoreOptions.keyRef = config.encryption.defaultKeyRef;
  }
  const jwtKeyStore = new JwtKeyStore(jwtKeyStoreDb, jwtKeyStoreOptions);
  await registerJwtAuth(app, config, { keyStore: jwtKeyStore });
  registerTenantHook(app);  /* 在 JWT 之后注册，确保 request.user 已填充 */
  /* CSRF guard registered BEFORE idempotency so it can short-circuit
   * with 403 before idempotency tries to cache the reply.send(). Only
   * affects cookie-authenticated state-changing requests on the
   * /api/v1/auth/refresh + /api/v1/auth/logout paths. */
  registerCsrf(app);
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

  /* a11y-friendly response headers — Vary: Accept-Language for future
   * localised responses, Preference-Applied for reduced-motion ack.
   *
   * NOT WIRED YET: the current Fastify onSend-hook implementation
   * conflicts with the idempotency-replay path (reply.send() from
   * inside preHandler races with our reply.header()). Until P1-AY-ext
   * refactors the plugin to attach headers at route registration time,
   * the helper remains available as a library function for routes that
   * need it explicitly. See `src/server/plugins/a11y-headers.ts` for
   * the implementation and the runbook for the deferred design. */
  void registerA11yHeaders;

  /* 多租户 OS 工厂 */
  const db = deps.db ?? deps.os.getDatabase();
  const tx = db;
  const uowFactory: UnitOfWorkFactory = deps.uowFactory
    ?? new NodeUnitOfWorkFactory(db, new NodeEventPublisher());
  const services = buildAppServices(db, config, deps.logger);
  const tenantFactory = new TenantOSFactory(
    db,
    deps.os.getClock(),
    deps.os.getLogger(),
    /* 透传给所有租户 OS：①ADR-0054 主动性配置（红线 3）；②ADR-0048 动态成长预算开关。 */
    {
      ...(deps.config?.proactivity ? { proactivity: deps.config.proactivity } : {}),
      ...(deps.config?.companion ? { dynamicGrowthBudgetEnabled: deps.config.companion.dynamicGrowthBudgetEnabled } : {}),
    },
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

  /* ADR-0054 ③ OS 推送桥：订阅 companion:nudge-created → 同意门控（红线9）→ 系统推送（不带正文）。
   * 服务层（核心 OS 不认识 user/device/push）。订阅 root os.bus（默认租户）——多租户 factory OS 的
   * bus 桥接是登记的后续（同 SSE/WS 现状）。 */
  const nudgePushBridge = new NudgePushBridge({
    bus: deps.os.bus,
    db,
    pushService: services.pushService,
    logger: deps.os.getLogger(),
    now: () => deps.os.getClock().now(),
  });
  nudgePushBridge.start();
  app.addHook('onClose', () => { nudgePushBridge.stop(); });

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
      tx,
      deps.os.getLogger(),
      {
        pollIntervalMs: config.billing.reconciliation.pollIntervalMs,
        batchSize: config.billing.reconciliation.batchSize,
      },
    );
    settlementReconciliationWorker.start();
    app.addHook('onClose', async () => { await settlementReconciliationWorker!.stop(); });
  }

  /* dual-write outbox flush — drains persona_core_ledger_outbox into SqliteEventLedger */
  const flushWorker = new DualWriteFlushWorker({ db, logger: deps.logger });
  flushWorker.start();
  app.addHook('onClose', () => { flushWorker.stop(); });

  /* 任务队列（提前创建以便注入健康路由） */
  let worker: TaskWorker | undefined;
  let bulkImportTaskQueue: TaskQueue | undefined;
  if (config.queue.enabled) {
    const queueDb = deps.db ?? deps.os.getDatabase();
    const queue = new TaskQueue(queueDb, undefined, {
      maxPendingPerTenant: config.queue.maxPendingPerTenant,
      completedRetentionMs: config.queue.completedRetentionMs,
    });
    bulkImportTaskQueue = queue;
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
    const queueTx = queueDb;
    const autorunStore = new AvatarAutorunStore(queueDb);
    const knowledgeStore = new KnowledgeSourceStore(queueTx);
    const avatarService = new AvatarService(queueTx);
    const quotaManager = new QuotaManager(queueTx);
    const knowledgeRegistry = new KnowledgeSourceRegistry();
    knowledgeRegistry.register('manual', new ManualKnowledgeSource());
    knowledgeRegistry.register('rss', new RssKnowledgeSource());
    knowledgeRegistry.register('api', new ApiKnowledgeSource());
    knowledgeRegistry.register('file', new FileKnowledgeSource());
    const byokEncryption = tryByokEncryption(config.encryption);
    const llmRouter = new ModelRouter({
      provider: config.intelligence.provider,
      model: config.intelligence.model,
      embeddingModel: config.intelligence.embeddingModel,
      /* BYOK：app-init 默认租户 router——优先默认租户的加密 key，缺失回退全局 config。 */
      apiKey: resolveLlmApiKeyAtStartup(db, 'default', config.intelligence.provider, byokEncryption, config.intelligence.apiKey),
      baseUrl: config.intelligence.baseUrl,
      fallbacks: config.intelligence.fallbacks,
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
      /* ADR-0047 growth 档：注入 LLM 路由（含 D2 降级链），autorun 在确定性反思后额外跑 LLM 反思。
       * mock provider 不产实际成长（仅占位），生产配 anthropic/ollama 时生效。 */
      config.intelligence.provider === 'mock' ? undefined : llmRouter,
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

  /* P1-B 知识批量导入：service 在 queue 启用与否都可用（≤20 条走同步路径）
   * 注入 templateService 启用 expectedTemplateId 校验（建议 2 联动）
   * P1-D 注入 UsageTracker + BillingOutbox 上报 bulk_knowledge_import_item */
  const bulkImportPersonaCoreService = new PersonaCoreService(tx);
  const bulkImportTemplateService = new PersonaTemplateService(tx, bulkImportPersonaCoreService);
  bulkImportTemplateService.syncBuiltins();
  const p1dUsageTracker = new P1dUsageTracker(tx);
  const p1dBillingOutbox = config.stripe.enabled ? new P1dBillingOutbox(tx, config) : undefined;
  const stripeCustomerLookup = (tenantId: string): string | null => {
    try {
      const row = db.prepare<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM subscriptions
          WHERE tenant_id = ? AND stripe_customer_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
      ).get(tenantId);
      return row?.stripe_customer_id ?? null;
    } catch {
      return null;
    }
  };
  const bulkImportService = new BulkImportService(
    tx,
    bulkImportPersonaCoreService,
    bulkImportTaskQueue,
    new UrlContentFetcher(),
    deps.os.getLogger(),
    bulkImportTemplateService,
    p1dUsageTracker,
    p1dBillingOutbox,
    config.stripe.enabled ? stripeCustomerLookup : undefined,
  );
  if (worker) {
    registerBulkImportHandler(worker, bulkImportService, deps.os.getLogger());
  }

  /* P1-C 对话接入层（生产级）：
   * - 独立 ModelRouter（避免和后台知识摄入混用 token budget）
   * - 字段加密、配额/预算/成本追踪、断路器、PII 脱敏全部接入 */
  const conversationByokEncryption = tryByokEncryption(config.encryption);
  const conversationLlmRouter = new ModelRouter({
    provider: config.intelligence.provider,
    model: config.intelligence.model,
    embeddingModel: config.intelligence.embeddingModel,
    /* BYOK：默认租户对话 router——优先默认租户的加密 key，缺失回退全局 config。 */
    apiKey: resolveLlmApiKeyAtStartup(db, 'default', config.intelligence.provider, conversationByokEncryption, config.intelligence.apiKey),
    baseUrl: config.intelligence.baseUrl,
    fallbacks: config.intelligence.fallbacks,
    maxTokens: config.intelligence.maxTokens,
    temperature: config.intelligence.temperature,
  });
  const conversationEncryption = config.encryption.enabled ? new ConversationFieldEncryption(config.encryption) : undefined;
  const conversationTokenBudget = new ConversationTokenBudget(config.intelligence.budget, db);
  const conversationCostTracker = new ConversationCostTracker(db);
  const conversationQuotaManager = new QuotaManager(tx);
  const conversationCircuitBreaker = new ConversationCircuitBreaker({
    failureThreshold: 5,
    halfOpenMaxRequests: 1,
    resetTimeoutMs: 60_000,
    executionTimeoutMs: 30_000,
  });
  const conversationService = new ConversationService({
    tx,
    llm: conversationLlmRouter,
    personaCoreService: bulkImportPersonaCoreService,
    logger: deps.os.getLogger(),
    encryption: conversationEncryption,
    tokenBudget: conversationTokenBudget,
    costTracker: conversationCostTracker,
    quotaManager: conversationQuotaManager,
    circuitBreaker: conversationCircuitBreaker,
    /* P1-D：用量追踪 + Stripe 计量上报 */
    usageTracker: p1dUsageTracker,
    billingOutbox: p1dBillingOutbox,
    stripeCustomerLookup: config.stripe.enabled ? stripeCustomerLookup : undefined,
    guardOptions: {
      /* 按 provider 真实 embedding 能力判断（无 key 的 ollama 也算；anthropic 不支持则不注入），而非 apiKey 真值 */
      embeddingProvider: intelligenceProvidesEmbeddings(config) ? conversationLlmRouter : undefined,
    },
    retrieverOptions: {
      embeddingProvider: intelligenceProvidesEmbeddings(config) ? conversationLlmRouter : undefined,
      logger: deps.os.getLogger(),
    },
  });
  /* P1-D 订阅状态闸门：在 conversation 路由 preHandler 调用 */
  const subscriptionGate = new SubscriptionGateService(tx);
  const conversationRetentionWorker = new ConversationRetentionWorker(
    conversationService,
    conversationService.getConfirmationStore(),
    deps.os.getLogger(),
  );
  conversationRetentionWorker.start();
  app.addHook('onClose', async () => { await conversationRetentionWorker.stop(); });

  /* quota_usage 旧窗口清理：计量只读当前窗口，关闭的旧窗口行无限累积——周期性删除。 */
  const quotaUsageRetentionWorker = new QuotaUsageRetentionWorker(conversationQuotaManager, deps.os.getLogger());
  quotaUsageRetentionWorker.start();
  app.addHook('onClose', async () => { await quotaUsageRetentionWorker.stop(); });

  /* P3 Agent / MCP Server 装配 */
  const toolPermissionService = new ToolPermissionService(tx);
  const agencyAuthorizationService = new AgencyAuthorizationService(tx);

  /**
   * F2：用户级 Google OAuth
   *  - encryption.enabled=true → 复用 conversationEncryption（密文落盘）
   *  - encryption.enabled=false → 使用 IdentityEncryption（明文直通；仅测试/开发）
   */
  const agentOauthEncryption: TokenEncryption | ConversationFieldEncryption =
    conversationEncryption ?? new IdentityEncryption();
  const userOauthTokenService = new UserOauthTokenService(tx, agentOauthEncryption);
  const googleOauthEnabled = !!(config.agent.oauth.google.clientId
    && config.agent.oauth.google.clientSecret
    && config.agent.oauth.google.redirectUri);
  const googleOauthFlow = googleOauthEnabled ? new GoogleOauthFlow({
    clientId: config.agent.oauth.google.clientId,
    clientSecret: config.agent.oauth.google.clientSecret,
    redirectUri: config.agent.oauth.google.redirectUri,
  }) : null;
  const toolRegistry = new ToolRegistry();

  toolRegistry.register(new PersonaContextTool(bulkImportPersonaCoreService));
  toolRegistry.register(new MemorySearchTool(bulkImportPersonaCoreService));
  toolRegistry.register(new MemoryAddTool(bulkImportPersonaCoreService));
  toolRegistry.register(new KnowledgeQueryTool(conversationService.getRetriever()));
  toolRegistry.register(new DecisionRecordTool(bulkImportPersonaCoreService));
  /* ADR-0048：人才市场经济行为工具（apply/submit 走 pipeline 治理） */
  toolRegistry.register(new MarketplaceTool(bulkImportPersonaCoreService));
  /* P3-C 外部工具适配器 */
  toolRegistry.register(new WebSearchTool({
    provider: config.agent.webSearch.provider,
    apiKey: config.agent.webSearch.apiKey,
    maxResults: config.agent.webSearch.maxResults,
    maxContentLength: config.agent.webSearch.maxContentLength,
    costCentsPerCall: config.agent.webSearch.costCentsPerCall,
  }, deps.os.getLogger()));
  toolRegistry.register(new CalendarTool({
    provider: config.agent.calendar.provider,
    serviceAccountJson: config.agent.calendar.serviceAccountJson,
    oauthAccessToken: config.agent.calendar.oauthAccessToken,
    defaultTimezone: config.agent.calendar.defaultTimezone,
  }, deps.os.getLogger()));
  toolRegistry.register(new EmailTool({
    provider: config.agent.email.provider,
    serviceAccountJson: config.agent.email.serviceAccountJson,
    oauthAccessToken: config.agent.email.oauthAccessToken,
    dryRun: config.agent.email.dryRun,
    maxAttachmentBytes: config.agent.email.maxAttachmentBytes,
  }, deps.os.getLogger()));
  toolRegistry.freeze();

  const toolInvocationPipeline = new ToolInvocationPipeline({
    tx,
    registry: toolRegistry,
    logger: deps.os.getLogger(),
    permissions: toolPermissionService,
    authorizations: agencyAuthorizationService,
    confirmationStore: conversationService.getConfirmationStore(),
  });
  const mcpServer = new ChronoMcpServer(toolRegistry, toolInvocationPipeline, deps.os.getLogger());

  /* ADR-0048：自主挣钱编排服务。决策走 autonomous 模式（确定性，rule-engine 为主，
   * 不调 LLM），故 embedding index 仅为构造满足、autonomous 路径不查询。 */
  const earningEmbeddingIndex = new InMemoryEmbeddingIndex(
    tx, deps.os.getClock(), conversationLlmRouter, config.intelligence.embeddingModel,
  );
  const earningDecisionEngine = new DecisionEngine(
    deps.os.core,
    new RetrievalService(deps.os.core.memories, earningEmbeddingIndex),
    conversationLlmRouter,
    deps.os.getClock(),
    deps.os.getLogger(),
    config.intelligence.simulation,
    new RuleEngine(deps.os.getClock(), config.ruleEngine, deps.os.getLogger()),
  );
  const personaEarningService = new PersonaEarningService({
    personaCore: bulkImportPersonaCoreService,
    decisionEngine: earningDecisionEngine,
    pipeline: toolInvocationPipeline,
    bus: deps.os.bus,
    clock: deps.os.getClock(),
    logger: deps.os.getLogger(),
    /* ADR-0048 多实例 gating：复用 OS 的 per-persona 锁，串行化每个 persona 的挣钱周期 */
    leaseStore: deps.os.personaLeases,
  });

  /* F2/F3：用户级 OAuth resolver 工厂（每个请求构造独立 resolver） */
  const oauthResolverFactory = createUserOauthTokenResolverFactory({
    tokens: userOauthTokenService,
    googleFlow: googleOauthFlow,
    logger: deps.os.getLogger(),
  });

  /* F4：tool_invocations retention worker */
  const toolInvocationsRetentionWorker = new ToolInvocationsRetentionWorker(
    toolPermissionService,
    deps.os.getLogger(),
    {
      retentionMs: config.agent.toolInvocationsRetentionDays * 24 * 60 * 60 * 1000,
    },
  );
  toolInvocationsRetentionWorker.start();
  app.addHook('onClose', async () => { await toolInvocationsRetentionWorker.stop(); });

  /* 路由 */
  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, services);
  registerOrganizationRoutes(app, services);
  registerBillingRoutes(app, db, config);
  /* earn→distill 闭环（WP-0）：任务完成 → 经 tenant OS 的 earningDistiller 把高质量 outcome
   * 蒸馏成 core value 候选（经蒸馏门，不绕过）。回调在此注入，因为这里能拿到 os + tenantFactory。 */
  const onMarketplaceTaskCompleted = (event: import('./routes/persona-core.js').MarketplaceTaskCompletedEvent): void => {
    const tenantOS =
      tenantFactory && event.tenantId && event.tenantId !== 'default'
        ? tenantFactory.getTenantOS(event.tenantId)
        : deps.os;
    const values = [...tenantOS.core.values.getAll().values()].map((v) => ({
      id: v.id, label: v.label, weight: v.weight,
    }));
    const target = resolveTargetValueForCategory(event.category, values);
    /* distill 内部对低质量(<0.5)/无映射会自行跳过；targetValue 缺省则不产 value_shift。 */
    tenantOS.earningDistiller.distill({
      tenantId: event.tenantId,
      personaId: event.personaId,
      taskId: event.taskId,
      category: event.category,
      qualityScore: event.qualityScore,
      payout: event.payout,
      targetValue: target ?? undefined,
    });
  };
  registerPersonaCoreRoutes(app, db, config, onMarketplaceTaskCompleted);
  registerHealthRoutes(app, {
    os: deps.os,
    db: deps.db,
    circuitBreaker: deps.circuitBreaker,
    worker,
    observabilityWorker,
    runtimeRecoveryWorker,
    settlementReconciliationWorker,
    conversationService,
    conversationRetentionWorker,
  });
  registerValueRoutes(app, deps.os, tenantFactory);
  registerMemoryRoutes(app, deps.os, tenantFactory, config);
  registerNarrativeRoutes(app, deps.os, tenantFactory);
  registerCompanionRoutes(app, deps.os, tenantFactory, db, config);
  registerCompanionPerceiveRoutes(app, deps.os, tenantFactory, db, config);
  registerCompanionPerceiveStreamRoutes(app, deps.os, tenantFactory, db, config);
  registerCompanionEnvironmentRoutes(app, deps.os, tenantFactory);
  registerCompanionChatRoutes(app, deps.os, tenantFactory, db, config);
  registerPersonaRoutes(app, deps.os, tenantFactory);
  registerSnapshotRoutes(app, deps.os, tenantFactory);
  registerOperationRoutes(app, deps.os, tenantFactory, config);
  registerConflictRoutes(app, db, config);
  registerMetricsRoutes(app, deps.os, config);
  registerAuditRoutes(app, db);
  registerAnalyticsRoutes(app, db);
  registerDashboardRoutes(app, db);
  registerPosRoutes(app, deps.os, tenantFactory);
  registerDecisionRoutes(app, deps.os, config, db, tenantFactory);
  registerOnboardingRoutes(app, deps.os, config, db, tenantFactory);
  registerOnboardingV2Routes(app, config, db, services.organization);
  registerVisualizationRoutes(app, deps.os, tenantFactory);
  registerPrivacyRoutes(app, deps.os, tenantFactory, config);
  registerLifeSimulationRoutes(app, deps.os.lifeSimulation, { queueEnabled: config.queue.enabled, db, config });
  registerLifeSimVizRoutes(app, deps.os.lifeSimulation);
  registerSsoRoutes(app, db, config);
  registerOidcRoutes(app, db, config);
  registerScimRoutes(app, services);
  registerCollaborationRoutes(app, services);
  registerApiKeyRoutes(app, services);
  registerAdminConfigRoutes(app, db, config);
  registerAdminTemplateRoutes(app, deps.os);
  registerBulkKnowledgeImportRoutes(app, {
    bulkImport: bulkImportService,
    personaCore: bulkImportPersonaCoreService,
  });
  registerConversationRoutes(app, {
    conversation: conversationService,
    personaCore: bulkImportPersonaCoreService,
    subscriptionGate,
    db,
  });
  /* ADR-0047：蒸馏治理端点（审查/审批/拒绝自我修改工件） */
  registerDistillationRoutes(app, {
    distillation: deps.os.distillation,
    personaCore: bulkImportPersonaCoreService,
  });
  /* ADR-0048：自主挣钱治理端点（触发周期 / work feed / 钱包视图） */
  registerEarningRoutes(app, {
    earning: personaEarningService,
    personaCore: bulkImportPersonaCoreService,
    db,
  });
  registerAdminDeploymentRoutes(app, db, config);
  registerAdminControlPlaneRoutes(app, services);
  registerAdminToolsRoutes(app, db);
  registerMcpRoutes(app, mcpServer, oauthResolverFactory);
  registerAgentOauthRoutes(app, {
    googleFlow: googleOauthFlow,
    tokens: userOauthTokenService,
    config,
  });
  registerAgentConfirmationsRoutes(app, {
    mcpServer,
    permissions: toolPermissionService,
    oauthResolverFactory,
  });
  registerMobileRoutes(app, services);
  registerIdentityRoutes(app, services);
  registerAvatarRoutes(app, db, deps.os, tenantFactory);
  registerKnowledgeSourceRoutes(app, services);
  registerSseRoutes(app, deps.os, config);
  registerFeatureFlagRoutes(app, deps.os, config);
  registerV2Routes(app, db, config, uowFactory, flushWorker, deps.os, tenantFactory);

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
    const billingOutbox = new BillingOutbox(tx, config);
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
