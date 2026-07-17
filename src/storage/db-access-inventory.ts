/**
 * DB-访问点盘点（分片地基 Phase -1）。
 *
 * 全仓每个「拿 db 的点」（os.getDatabase() / 裸 db 捕获 / 构造器注入）逐个归到 8 类之一（见分片 spec）。
 * 这是 shard 路由的权威边界：Phase 0 据此把每类接到 dbForTenant/coordinatorDb/fan-out。
 * 完整性由 `scripts/check-db-access-ratchet.mjs` 保证——新增未归类拿点 → CI 红。
 *
 * 归类依据（spec 8 类）：
 *   tenant-isolated       随租户 shard，经 dbForTenant
 *   parent-inherited      无自己 tenant_id 靠父表 JOIN 归属，随父租户 shard
 *   platform-table        无 tenant_id 全局，协调库或每实例
 *   global-worker         跨租户迭代 worker/timer，per-shard 或协调库跑
 *   explicit-per-request  request handler 内一次性取 db，换 db 源即可（小改）
 *   longlived-root-capture 注册/构造期捕获 root db/os + 绑子服务，Phase 0 生命周期重构（大改）
 *   module-singleton      模块级/全局单例 db 引用，单列
 *   root-only             确无租户归属，协调库
 */

export type DbAccessCategory =
  | 'tenant-isolated'
  | 'parent-inherited'
  | 'platform-table'
  | 'global-worker'
  | 'explicit-per-request'
  | 'longlived-root-capture'
  | 'module-singleton'
  | 'root-only';

export interface DbAccessPoint {
  /** 稳定 ID：`<repo相对路径>#<符号>`（供 ratchet 比对，不含行号——防行号漂移）。 */
  readonly id: string;
  readonly file: string;
  readonly category: DbAccessCategory;
  readonly note?: string;
}

/**
 * 当前全部 DB-访问点归类。逐条对应 `grep -rn "\.getDatabase()"` /
 * `grep -rn "= db ?? os.getDatabase()|= os.getDatabase()|this.os.getDatabase()"` 在
 * src 下（排除 test/.d.ts）的实际枚举结果。任一遗漏 → ratchet 红。
 */
export const DB_ACCESS_INVENTORY: readonly DbAccessPoint[] = [
  // —— longlived-root-capture（Phase 0 生命周期重构，大改） ——
  { id: 'src/server/routes/decisions.ts#registerDecisionRoutes', file: 'src/server/routes/decisions.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + TokenBudget/CostTracker/UsageTracker/QuotaManager/BillingOutbox' },
  { id: 'src/server/routes/onboarding.ts#registerOnboardingRoutes', file: 'src/server/routes/onboarding.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + 5 子服务（同 decisions 款）' },
  { id: 'src/server/routes/companion/chat.ts#registerCompanionChatRoutes', file: 'src/server/routes/companion/chat.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + QuotaManager' },
  { id: 'src/server/routes/companion/perceive.ts#registerCompanionPerceiveRoutes', file: 'src/server/routes/companion/perceive.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + QuotaManager（同 companion/chat 款，spec 未点名但同一模式）' },
  { id: 'src/server/routes/companion/perceive-stream.ts#registerCompanionPerceiveStreamRoutes', file: 'src/server/routes/companion/perceive-stream.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + QuotaManager（同 companion/chat 款，spec 未点名但同一模式）' },
  { id: 'src/server/routes/personas.ts#registerPersonaRoutes', file: 'src/server/routes/personas.ts', category: 'longlived-root-capture', note: '注册期 new PersonaCoreService(os.getDatabase()) 长寿命' },
  { id: 'src/server/routes/admin-templates.ts#registerAdminTemplateRoutes', file: 'src/server/routes/admin-templates.ts', category: 'longlived-root-capture', note: '注册期 tx=os.getDatabase() 绑 PersonaCoreService/PersonaTemplateService 长寿命（同 personas 款）' },
  { id: 'src/core/memory-facade.ts#MemoryFacade', file: 'src/core/memory-facade.ts', category: 'longlived-root-capture', note: '构造期 this.sharedDb；:221 绕 TenantDatabase UPDATE memory_nodes 静默错-shard（Phase 0 具名验收，Phase -1 不修）' },
  { id: 'src/privacy/privacy-service.ts#PrivacyService', file: 'src/privacy/privacy-service.ts', category: 'longlived-root-capture', note: '捕获长寿命 root os，方法内反复 this.os.getDatabase()' },
  { id: 'src/workforce/workforce-persona-bootstrap-service.ts#WorkforcePersonaBootstrapService', file: 'src/workforce/workforce-persona-bootstrap-service.ts', category: 'longlived-root-capture', note: '构造器捕获 this.os，bootstrap/hireWorker 方法内反复 this.os.getDatabase().transaction(...)——第 6 类第四种写法（同 privacy-service 款）' },
  { id: 'src/server/app.ts#createApp', file: 'src/server/app.ts', category: 'longlived-root-capture', note: '全应用最大 root capture：:275 const db=deps.db??deps.os.getDatabase() 绑几十个子服务/route/worker；:356 queueDb 绑 TaskQueue/AvatarAutorunStore/KnowledgeSourceStore/AvatarService/QuotaManager 等' },
  { id: 'src/server/app.ts#jwtKeyStore', file: 'src/server/app.ts', category: 'platform-table', note: ':221 jwtKeyStoreDb 绑 JwtKeyStore；访问平台级 jwt_signing_keys（无 tenant_id）→归协调库；每 60s reload timer 见 jwt-auth.ts:278-299（分片 spec 第 123 行 + 第 4 轮复审：归协调库，非按租户重建）' },
  { id: 'src/chrono-synth-os.ts#ChronoSynthOS.constructor', file: 'src/chrono-synth-os.ts', category: 'longlived-root-capture', note: ':184 this.db=config.db??createMemoryDatabase() 内核实例整个生命周期捕获；比 app.ts 更底层的根（TenantOSFactory 传入的 tenantDb 最终灌进这里）——ratchet PATTERNS 第 2 条须覆盖 `config.db ?? `别名传播，非仅字面量 `db`' },
  // —— explicit-per-request（handler 内一次性取 db，换源即可） ——
  { id: 'src/server/routes/privacy.ts#registerPrivacyRoutes', file: 'src/server/routes/privacy.ts', category: 'explicit-per-request', note: 'auditPrivacy 闭包 + /export/:exportId/download handler 内当场 os.getDatabase()，未绑子服务' },
  { id: 'src/server/routes/v2/index.ts#registerV2Routes', file: 'src/server/routes/v2/index.ts', category: 'explicit-per-request', note: '3 处 recordPrivacyAudit(os.getDatabase(),...) 均在 request handler 内当场取，未捕获成字段' },
  { id: 'src/server/app.ts#createApp.idempotencyDb', file: 'src/server/app.ts', category: 'explicit-per-request', note: ':240 registerIdempotency 拿一次 db 传入插件，handler 内按 tenantId AND id 查询，未绑子服务生命周期' },
  { id: 'src/server/app-services.ts#buildAppServices', file: 'src/server/app-services.ts', category: 'explicit-per-request', note: '仅接收已解析 db 参数向下分发给一堆 new XxxService(tx)（依赖注入分发点，非拿取）；调用点在 app.ts:279（已归 app.ts#createApp 的 longlived-root-capture）；登记以让 ratchet 对 `buildAppServices(` 定义签名本身绿' },
  { id: 'src/server/routes/workforce-admin.ts#registerWorkforceAdminRoutes', file: 'src/server/routes/workforce-admin.ts', category: 'explicit-per-request', note: ':75 命中的是注释文字（说明 bootstrap 内部 tenantOS.getDatabase().transaction() 的原子性），非真实代码拿点；真实拿点在 workforce-persona-bootstrap-service.ts（已归类 longlived-root-capture）。登记以消除 ratchet 误报' },
  // —— tenant-isolated（tenantOS 已经过 getOS/tenantFactory.getTenantOS(tid) 按租户路由，
  //     其 .getDatabase() 语义上即「该租户所在 shard 的 db」；Phase 0 TenantOSFactory 内部换源后自动生效，此处不用改） ——
  { id: 'src/core/memory-facade.ts#getEngine', file: 'src/core/memory-facade.ts', category: 'tenant-isolated', note: ':149 createEmbeddingIndex 用 tenantOS.getDatabase()，tenantOS 已经 this.getOS(tenantId) 路由' },
  { id: 'src/server/routes/operations.ts#registerOperationRoutes', file: 'src/server/routes/operations.ts', category: 'tenant-isolated', note: ':32 tenantOS=getOS(request) 路由后取 db 传 PersonaDriftAnalyzer' },
  { id: 'src/server/routes/decisions.ts#getEngine', file: 'src/server/routes/decisions.ts', category: 'tenant-isolated', note: ':119 createEmbeddingIndex 用 tenantOS.getDatabase()，tenantOS 已经 getOS(tenantId) 路由' },
  { id: 'src/server/routes/onboarding.ts#getEngine', file: 'src/server/routes/onboarding.ts', category: 'tenant-isolated', note: ':139 createEmbeddingIndex 用 tenantOS.getDatabase()，tenantOS 已经 getOS(tenantId) 路由' },
  { id: 'src/server/routes/companion/me.ts#proactiveStore', file: 'src/server/routes/companion/me.ts', category: 'tenant-isolated', note: ':312 ProactiveMessageStore 用 tenantOS.getDatabase()，tenantOS 已经 getOS(request) 路由' },
  { id: 'src/multi-tenant/tenant-os-factory.ts#createTenantOS', file: 'src/multi-tenant/tenant-os-factory.ts', category: 'tenant-isolated', note: ':111 new TenantDatabase(this.db, tenantId) 是 tenant-isolated 语义的落地机制本身——把宿主 db 包成该租户视图；Phase 0 换宿主 db 为 dbForTenant(tenantId) 后自动生效' },
  // —— module-singleton ——
  { id: 'src/server/plugins/websocket.ts#eventLogDb', file: 'src/server/plugins/websocket.ts', category: 'module-singleton', note: '模块级单例 + :219-221 全局 prune timer；ws_event_log' },
  // —— global-worker / fan-out ——
  { id: 'src/server/routes/metrics.ts#MetricsQueryService', file: 'src/server/routes/metrics.ts', category: 'global-worker', note: '跨租户聚合 fan-out（Phase 2 scatter-gather）' },
  // —— root-only（确无租户归属，造顶层 db 实例的工厂原语） ——
  { id: 'src/storage/factory.ts#createDatabase', file: 'src/storage/factory.ts', category: 'root-only', note: '全仓唯一制造顶层 db 实例的工厂（new PostgresDatabase/new SqliteDatabase）；是 Phase 0 shard 路由要改造的根源——ShardRouter 将按 shard 配置多次调用此工厂' },
  { id: 'src/storage/database.ts#createMemoryDatabase', file: 'src/storage/database.ts', category: 'root-only', note: 'new SqliteDatabase(\':memory:\') 内存库工厂（测试/无配置兜底用，chrono-synth-os.ts 默认走它）；同 factory.ts#createDatabase 性质，与租户分片无关的顶层构造原语' },
];
