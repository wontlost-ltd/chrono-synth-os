/**
 * DB-访问点盘点（分片地基 Phase 0 · Plan 0）。
 *
 * 全仓每个「拿 db 的点」逐个归到 8 类之一（见分片 spec §3-B）；这是 shard 路由的权威边界，
 * Phase 0 据此把每类接到 dbForTenant/coordinatorDb/fan-out。
 *
 * **升级为 sink 级（Plan 0 · Task 3）**：`category`（8 类，原盘点粒度）不变，
 * 新增两个必填字段：
 *   - `disposition`：目标处置（六值），是「放开门」真正依据的分类——见 spec §3-A0/§4.1/§5.1/§5.2。
 *   - `wiringStatus`：`'planned'|'wired'|'verified'`。Plan 0 只盘点不接线，全填 `'planned'`；
 *     接线在 Plan 1/2/3；放开 fail-closed（Plan 3）要求危险 edge 全 `'verified'`。
 *
 * **两级 id 并存（诚实标注，不伪造边界）**：
 *   - **legacy 层**（Phase -1 遗留，file 级 id `<file>#<owner>`）：`check-db-access-ratchet.mjs`
 *     的文件级正则仍读它的 `file` 字段；这些条目覆盖面广但粒度粗，未逐 edge 拆分——
 *     大文件（app.ts 1315 条/companion-chat.ts 321 条/onboarding.ts 211 条 edge）
 *     逐条拆分是 Task 4 迭代补登记的工作，非 Task 3 一次性交付。
 *   - **edge 层**（Task 2 scanner 产出的 edge 级 id `<file>#<owner>::<kind>::<target>::<param>`）：
 *     spec §3-A0「已知必纳入的 sink」第 1-7 类逐条登记（`scanProductionDbCapabilityEdges` 的
 *     真实产出——用临时 dump 脚本核实，非猜测）。这是 sink 级盘点新增的精确层。
 *   两层 id 空间不冲突：`collectUnregisteredEdges` 只做 `edges.filter(e => !inventoryIds.has(e.id))`
 *   纯比较，legacy id 不匹配任何真实 edge id 时是惰性存在（不影响、不伪造覆盖）。
 *
 * ⚠️ ratchet 覆盖边界：legacy 文件级正则挡「新文件引入顶层拿-db 点」，不覆盖构造器注入 sink /
 *   同文件内新增的第二个不同性质拿点——这正是 edge 级盘点要补的缺口，完整性由
 *   `scripts/check-db-access-ratchet.mjs`（file 级，Task 4 前）+ Task 4 起的
 *   `scanProductionDbCapabilityEdges` + `collectUnregisteredEdges`（edge 级主门）共同兜底。
 *
 * 归类依据（spec 8 类，category）：
 *   tenant-isolated       随租户 shard，经 dbForTenant
 *   parent-inherited      无自己 tenant_id 靠父表 JOIN 归属，随父租户 shard
 *   platform-table        无 tenant_id 全局，协调库或每实例
 *   global-worker         跨租户迭代 worker/timer，per-shard 或协调库跑
 *   explicit-per-request  request handler 内一次性取 db，换 db 源即可（小改）
 *   longlived-root-capture 注册/构造期捕获 root db/os + 绑子服务，Phase 0 生命周期重构（大改）
 *   module-singleton      模块级/全局单例 db 引用，单列
 *   root-only             确无租户归属，协调库
 *
 * 处置类（spec §3-A0/§4.1/§5.1/§5.2，disposition）：
 *   resolver           下沉接 resolver.dbForTenant(tenantId)（长期持有 db 能力的 tenant-scoped 服务）
 *   coordinator        下沉接 coordinatorDb（无 tenant_id 的平台级表/查询）
 *   mixed-scope        同时含平台级定位查询 + 租户级写（仅 Auth/SSO/OIDC，见 spec §4.1 状态机）
 *   per-shard-worker    跨租户扫描的 worker/timer，改 for (const db of resolver.allShardDbs())
 *   root-only           确无租户归属的顶层构造原语（工厂/路由引擎本身），非拿-host-db 访问点
 *   known-limitation    Phase 0 明确不下沉（note 必须说明「为何不可能错-shard」的理由）
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

export type DbAccessDisposition =
  | 'resolver'
  | 'coordinator'
  | 'mixed-scope'
  | 'per-shard-worker'
  | 'root-only'
  | 'known-limitation';

export interface DbAccessPoint {
  /**
   * 稳定 ID。两级并存（见文件头注释）：
   *   - legacy：`<repo相对路径>#<符号>`（不含行号——防行号漂移）。
   *   - edge（Task 2 起）：`<repo相对路径>#<owner>::<kind>::<target>::<param>`。
   */
  readonly id: string;
  readonly file: string;
  readonly category: DbAccessCategory;
  /** 目标处置（必填，Plan 0 起）——放开门据此判断而非 category。 */
  readonly disposition: DbAccessDisposition;
  /** 接线状态（必填）。Plan 0 阶段全部 'planned'（只盘点不接线）。 */
  readonly wiringStatus: 'planned' | 'wired' | 'verified';
  readonly note?: string;
}

/**
 * 当前全部 DB-访问点归类。
 *
 * legacy 段：逐条对应 `grep -rn "\.getDatabase()"` /
 * `grep -rn "= db ?? os.getDatabase()|= os.getDatabase()|this.os.getDatabase()"` 在
 * src 下（排除 test/.d.ts）的实际枚举结果——file 级粒度，Phase -1 遗留。
 *
 * edge 段：spec §3-A0「已知必纳入的 sink」第 1-7 类，用
 * `enumerateDbCapabilityEdges(buildProgram('tsconfig.src.json').program, checker, uowType,
 * { includeTests: false })` 的真实产出核实（非猜测的 id），逐条登记。
 * unknown-boundary edge（AppConfig/app 类型递归预算超限，Task 2 已知缺口）不在此登记——
 * 那是扫描器自身待补的形态，非「已确认处置」的 sink。
 */
export const DB_ACCESS_INVENTORY: readonly DbAccessPoint[] = [
  // ============================================================
  // legacy 段（file 级，Phase -1 遗留，disposition/wiringStatus 补齐）
  // ============================================================

  // —— longlived-root-capture → disposition: resolver（Phase 0 下沉后走 dbForTenant/子服务 resolver 化） ——
  { id: 'src/server/routes/decisions.ts#registerDecisionRoutes', file: 'src/server/routes/decisions.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 sharedDb + TokenBudget/CostTracker/UsageTracker/QuotaManager/BillingOutbox' },
  { id: 'src/server/routes/onboarding.ts#registerOnboardingRoutes', file: 'src/server/routes/onboarding.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 sharedDb + 5 子服务（同 decisions 款）' },
  { id: 'src/server/routes/companion/chat.ts#registerCompanionChatRoutes', file: 'src/server/routes/companion/chat.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 sharedDb + QuotaManager' },
  { id: 'src/server/routes/companion/perceive.ts#registerCompanionPerceiveRoutes', file: 'src/server/routes/companion/perceive.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 sharedDb + QuotaManager（同 companion/chat 款，spec 未点名但同一模式）' },
  { id: 'src/server/routes/companion/perceive-stream.ts#registerCompanionPerceiveStreamRoutes', file: 'src/server/routes/companion/perceive-stream.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 sharedDb + QuotaManager（同 companion/chat 款，spec 未点名但同一模式）' },
  { id: 'src/server/routes/companion/learn-github.ts#registerCompanionLearnGithubRoutes', file: 'src/server/routes/companion/learn-github.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 :82 sharedDb=db??os.getDatabase() 绑 QuotaManager.fromResolver（同 companion/chat 款；handler 内另有 tenantOS.getDatabase() 走已路由 tenantOS，属 tenant-isolated 语义，但文件级 ratchet 以最重的 sharedDb 捕获归类）' },
  { id: 'src/server/routes/personas.ts#registerPersonaRoutes', file: 'src/server/routes/personas.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 PersonaCoreService.fromResolver(new SingleDbResolver(os.getDatabase())) 长寿命（仍捕获 root os.getDatabase()；双入口化后 service 持 source，待 app.ts 穿真 ShardRouter 消除）' },
  { id: 'src/server/routes/admin-templates.ts#registerAdminTemplateRoutes', file: 'src/server/routes/admin-templates.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '注册期 tx=os.getDatabase() 绑 SingleDbResolver→PersonaCoreService/PersonaTemplateService 长寿命（同 personas 款）' },
  { id: 'src/core/memory-facade.ts#MemoryFacade', file: 'src/core/memory-facade.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '构造期 this.sharedDb；:221 绕 TenantDatabase UPDATE memory_nodes 静默错-shard（Phase 0 具名验收，Phase -1 不修）' },
  { id: 'src/privacy/privacy-service.ts#PrivacyService', file: 'src/privacy/privacy-service.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '捕获长寿命 root os，方法内反复 this.os.getDatabase()；间接持有 LegalHoldService sink（见 edge 段 legal-hold-service.ts），两者须查同一 shard（spec §3-B 具名验收点）' },
  { id: 'src/workforce/workforce-persona-bootstrap-service.ts#WorkforcePersonaBootstrapService', file: 'src/workforce/workforce-persona-bootstrap-service.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '构造器捕获 this.os，bootstrap/hireWorker 方法内反复 this.os.getDatabase().transaction(...)——第 6 类第四种写法（同 privacy-service 款）' },
  { id: 'src/server/app.ts#createApp', file: 'src/server/app.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '全应用最大 root capture：:275 const db=deps.db??deps.os.getDatabase() 绑几十个子服务/route/worker；:356 queueDb 绑 TaskQueue/AvatarAutorunStore/KnowledgeSourceStore/AvatarService/QuotaManager 等。edge 数极大（scanner 实测 1315 条），逐 edge 拆分留给 Task 4 迭代补登记，非 Task 3 一次性交付' },
  { id: 'src/chrono-synth-os.ts#ChronoSynthOS.constructor', file: 'src/chrono-synth-os.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: ':184 this.db=config.db??createMemoryDatabase() 内核实例整个生命周期捕获；比 app.ts 更底层的根（TenantOSFactory 传入的 tenantDb 最终灌进这里）——ratchet PATTERNS 第 2 条须覆盖 `config.db ?? `别名传播，非仅字面量 `db`' },

  // —— explicit-per-request → disposition: resolver（handler 内一次性取 db，换源即可，小改） ——
  { id: 'src/server/routes/privacy.ts#registerPrivacyRoutes', file: 'src/server/routes/privacy.ts', category: 'explicit-per-request', disposition: 'resolver', wiringStatus: 'planned', note: 'auditPrivacy 闭包 + /export/:exportId/download handler 内当场 os.getDatabase()，未绑子服务' },
  { id: 'src/server/routes/v2/index.ts#registerV2Routes', file: 'src/server/routes/v2/index.ts', category: 'explicit-per-request', disposition: 'resolver', wiringStatus: 'planned', note: '3 处 recordPrivacyAudit(os.getDatabase(),...) 均在 request handler 内当场取，未捕获成字段' },
  { id: 'src/server/app.ts#createApp.idempotencyDb', file: 'src/server/app.ts', category: 'explicit-per-request', disposition: 'resolver', wiringStatus: 'planned', note: ':240 registerIdempotency 拿一次 db 传入插件，handler 内按 tenantId AND id 查询，未绑子服务生命周期' },
  { id: 'src/server/routes/workforce-admin.ts#registerWorkforceAdminRoutes', file: 'src/server/routes/workforce-admin.ts', category: 'explicit-per-request', disposition: 'resolver', wiringStatus: 'planned', note: ':75 命中的是注释文字（说明 bootstrap 内部 tenantOS.getDatabase().transaction() 的原子性），非真实代码拿点；真实拿点在 workforce-persona-bootstrap-service.ts（已归类 longlived-root-capture）。登记以消除 ratchet 误报' },

  // —— tenant-isolated → disposition: resolver（tenantOS 已经过 getOS/tenantFactory.getTenantOS(tid) 按租户路由，
  //     其 .getDatabase() 语义上即「该租户所在 shard 的 db」；Phase 0 TenantOSFactory 内部换源后自动生效） ——
  { id: 'src/core/memory-facade.ts#getEngine', file: 'src/core/memory-facade.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: ':149 createEmbeddingIndex 用 tenantOS.getDatabase()，tenantOS 已经 this.getOS(tenantId) 路由' },
  { id: 'src/server/routes/operations.ts#registerOperationRoutes', file: 'src/server/routes/operations.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: ':32 tenantOS=getOS(request) 路由后取 db 传 PersonaDriftAnalyzer' },
  { id: 'src/server/routes/decisions.ts#getEngine', file: 'src/server/routes/decisions.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: ':119 createEmbeddingIndex 用 tenantOS.getDatabase()，tenantOS 已经 getOS(tenantId) 路由' },
  { id: 'src/server/routes/onboarding.ts#getEngine', file: 'src/server/routes/onboarding.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: ':139 createEmbeddingIndex 用 tenantOS.getDatabase()，tenantOS 已经 getOS(tenantId) 路由' },
  { id: 'src/server/routes/companion/me.ts#proactiveStore', file: 'src/server/routes/companion/me.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: ':312 ProactiveMessageStore 用 tenantOS.getDatabase()，tenantOS 已经 getOS(request) 路由' },
  { id: 'src/server/routes/companion/draft-github-reply.ts#registerCompanionDraftGithubRoutes', file: 'src/server/routes/companion/draft-github-reply.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: 'handler 内 tenantOS.getDatabase()（:130/:136/:198 建 GithubAppCredentialStore/查 installation/GithubDraftStore），tenantOS 已经 getOS(request) 路由；无注册期 sharedDb 捕获、无长寿命子服务绑定——纯按租户路由后取 db，Phase 0 TenantOSFactory 换源后自动生效' },
  // —— explicit-per-request（GitHub webhook：系统入站，handler 内一次性取 db，无长寿命绑定） ——
  { id: 'src/server/routes/github-webhook.ts#registerGithubWebhookRoutes', file: 'src/server/routes/github-webhook.ts', category: 'explicit-per-request', disposition: 'mixed-scope', wiringStatus: 'planned', note: ':151 os.getDatabase() 作 installation→tenant 反查（读平台级 github_installations 映射，靠 UNIQUE(host,installation) 定位未知租户，故用基座 DB 不带 tenant 过滤——平台级定位）；:160/:180 反查出 tenantId 后经 tenantOSFor(tenantId) 路由再 tenantOS.getDatabase() 验签/存草稿（租户级写）。同时含平台级定位查询 + 租户级写，与 AuthService 同款 mixed-scope（spec §4.1），非单纯 resolver/coordinator 二选一' },
  { id: 'src/multi-tenant/tenant-os-factory.ts#createTenantOS', file: 'src/multi-tenant/tenant-os-factory.ts', category: 'tenant-isolated', disposition: 'resolver', wiringStatus: 'planned', note: ':111 new TenantDatabase(this.db, tenantId) 是 tenant-isolated 语义的落地机制本身——把宿主 db 包成该租户视图；Phase 0 换宿主 db 为 dbForTenant(tenantId) 后自动生效' },

  // —— module-singleton → disposition: known-limitation（模块级单例，Phase 0 暂不下沉，理由见 note） ——
  { id: 'src/server/plugins/websocket.ts#eventLogDb', file: 'src/server/plugins/websocket.ts', category: 'module-singleton', disposition: 'known-limitation', wiringStatus: 'planned', note: '模块级单例 + :219-221 全局 prune timer；ws_event_log 写入带 tenantId 列（非跨租户聚合查询），不可能错-shard 的理由：当前单库部署下该单例即 host db，多 shard 下若不下沉，写入仍落 host/home shard——功能退化为「只记录 home shard 事件」而非「写错租户数据」，无跨租户数据泄露/覆盖风险；Phase 0 明确暂不下沉，留 Phase 1+ 评估是否值得为审计日志単独做 per-shard fan-out' },

  // —— global-worker → disposition: per-shard-worker（跨租户聚合 fan-out，Phase 2 scatter-gather） ——
  { id: 'src/server/routes/metrics.ts#MetricsQueryService', file: 'src/server/routes/metrics.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '跨租户聚合 fan-out（Phase 2 scatter-gather，spec §5：population diversity/rollup SUM/tenant usage COUNT 各 shard 查后协调层合并）' },

  // —— root-only（确无租户归属，造顶层 db 实例的工厂原语） ——
  { id: 'src/storage/factory.ts#createDatabase', file: 'src/storage/factory.ts', category: 'root-only', disposition: 'root-only', wiringStatus: 'planned', note: '全仓唯一制造顶层 db 实例的工厂（new PostgresDatabase/new SqliteDatabase）；是 Phase 0 shard 路由要改造的根源——ShardRouter 将按 shard 配置多次调用此工厂' },
  { id: 'src/storage/database.ts#createMemoryDatabase', file: 'src/storage/database.ts', category: 'root-only', disposition: 'root-only', wiringStatus: 'planned', note: 'new SqliteDatabase(\':memory:\') 内存库工厂（测试/无配置兜底用，chrono-synth-os.ts 默认走它）；同 factory.ts#createDatabase 性质，与租户分片无关的顶层构造原语' },
  { id: 'src/storage/postgres-database.ts#PostgresDatabase', file: 'src/storage/postgres-database.ts', category: 'root-only', disposition: 'root-only', wiringStatus: 'planned', note: ':199 new Pool（pg 连接池，DB 适配器内部）；分片 spec 点名的单 pg.Pool 物理证据，Phase 0 ShardRouter 按 shard 复制' },
  /* 分片路由基建（Phase 0）：显式登记为 root-only 作人类可读的「已刻意判定」记录。二者都不触发 ratchet
   * PATTERNS（router 靠注入的 buildDb，自身无 new XxxDatabase(/new Pool(；hash 是纯函数），故 ratchet 永不
   * flag 它们；此处登记非 ratchet 强制，而是防未来读者误以为漏归类。它们是路由引擎本身，非「按 tenantId 拿
   * host db」的访问点。 */
  { id: 'src/storage/shard-router.ts#ShardRouter', file: 'src/storage/shard-router.ts', category: 'root-only', disposition: 'root-only', wiringStatus: 'planned', note: '分片路由引擎（实现 TenantDbResolver 契约），连接池 owner；池经注入的 buildDb 构造，自身不 new db——非拿-host-db 访问点，是路由机制本身' },
  { id: 'src/storage/shard-hash.ts#shardIdForTenant', file: 'src/storage/shard-hash.ts', category: 'root-only', disposition: 'root-only', wiringStatus: 'planned', note: '确定性 FNV-1a 模哈希纯函数（tenantId→shardId）；无任何 db 访问，登记仅为完整记录分片基建，与租户 host db 无关' },

  // ============================================================
  // edge 段（Task 2 scanner 产出的 edge 级 id，spec §3-A0 已知必纳入 sink 第 1-7 类）
  // 逐条 id 用 enumerateDbCapabilityEdges(..., {includeTests:false}) 真实产出核实。
  // 每类只登记非 unknown-boundary 的已知形态 edge（unknown-boundary 是扫描器递归预算超限
  // 的已知缺口，见 Task 2 遗留——不在此假装「已处置」，留 Task 4/后续补 taxonomy）。
  // ============================================================

  // —— #1 buildAppServices ~15 成员（app-services.ts）：全是启动期构造一次长期复用的 DB 服务，
  //     disposition 纠正为 resolver（原 explicit-per-request 错分类——判据=「是否长期持有 db 能力」）。 ——
  { id: 'src/server/app-services.ts#buildAppServices::capture::buildAppServices::db', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'buildAppServices 函数体内捕获 db 参分发给全部成员构造；A0 纠正：非 per-request DI 分发原语，是长期持有 db 能力的组装点（15 成员各自 new XxxService(tx) 长期复用）' },
  { id: 'src/server/app-services.ts#buildAppServices::decl-init::tx::db', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'const tx = db 别名声明——转移边界，随 db 参本体一并 resolver 化' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::AuthService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'new AuthService(tx, appConfig)——AuthService 本身是 mixed-scope（spec §4.1：平台级定位查询 + 租户级写），非单纯 resolver 长期服务' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::IdentityService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new IdentityService(tx) 长期持有 db，per-tenant 身份服务' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::AvatarService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new AvatarService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::CollaborationService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new CollaborationService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::MobileDeviceService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new MobileDeviceService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::MobileDeviceFacade::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new MobileDeviceFacade(tx, pushService) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::UserProfileService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new UserProfileService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::OrganizationService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new OrganizationService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::TenantEnterpriseProfileService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new TenantEnterpriseProfileService(tx, appConfig, logger) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::ScimProvisioningService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new ScimProvisioningService(tx, ...) 长期持有 db；企业级 SCIM 供应，租户范围内' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::AdminControlPlaneService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new AdminControlPlaneService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::ApiKeyService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new ApiKeyService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::ConfigService::db', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new ConfigService(db, appConfig) 长期持有 db；须核实 config 表是否 tenant-scoped 或需 coordinator（Phase 1 接线时定）' },
  { id: 'src/server/app-services.ts#buildAppServices::factory-indirect::KnowledgeSourceService::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'new KnowledgeSourceService(tx) 长期持有 db' },
  { id: 'src/server/app-services.ts#buildAppServices::return::return::db', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'return { db, ... } 把 db 本体也放进 AppServices 容器供路由层直用——AppServices.db 属性同款下沉' },
  { id: 'src/server/app-services.ts#buildAppServices::return::return::auth.tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'return { auth, ... } 转移 AuthService 内部 tx——随 AuthService mixed-scope 定性' },
  { id: 'src/server/app-services.ts#AppServices::deps-prop::AppServices::db', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'AppServices 接口的 db 属性签名——容器契约层声明，随 buildAppServices 实现下沉' },
  { id: 'src/server/app-services.ts#AppServices::deps-prop::AppServices::auth.tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'AppServices.auth 属性签名携带的 tx——随 AuthService mixed-scope 定性' },
  { id: 'src/server/app-services.ts#<anonymous>::factory-indirect::recordEvidence::tx', file: 'src/server/app-services.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'ScimProvisioningService 的 evidence 回调闭包内 recordEvidence(db, {...})——租户级 SOC2 证据写入，随容器整体下沉' },

  // —— #2 TaskQueue + AvatarAutorunStore/KnowledgeSourceStore/AvatarService（task-queue.ts + app.ts:399-401）——
  //     TaskQueue shard 归属见 spec §3-B「架构决策」：推荐①每 shard 一个 queue + 每 shard 一个 worker。
  //     disposition = per-shard-worker（enqueue 按 tenantId 落对应 shard，worker 遍历 allShardDbs 各拉各的）。 ——
  { id: 'src/queue/task-queue.ts#TaskQueue::ctor-param::TaskQueue::db', file: 'src/queue/task-queue.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '构造器注入 db；spec §3-B 架构决策推荐①每 shard 一个 queue+worker（enqueue→dbForTenant(tenantId)，worker 遍历 allShardDbs 各拉各的），非协调库统一队列' },
  { id: 'src/queue/task-queue.ts#TaskQueue::field-decl::TaskQueue::db', file: 'src/queue/task-queue.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '同 ctor-param db，字段声明层' },
  { id: 'src/queue/task-queue.ts#TaskQueue::field-decl::TaskQueue::tx', file: 'src/queue/task-queue.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '内部 tx 别名字段，同 db 一并 per-shard 化' },
  { id: 'src/queue/task-queue.ts#TaskQueue::assignment::this.db::db', file: 'src/queue/task-queue.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '构造器体内 this.db = db 赋值——转移边界，随字段声明一并处置' },
  { id: 'src/queue/task-queue.ts#TaskQueue::assignment::this.tx::db', file: 'src/queue/task-queue.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '构造器体内 this.tx = db 赋值——同 this.db 一并处置' },

  // —— #3 LegalHoldService（legal-hold-service.ts:82，经 PrivacyService 注入）——
  //     须与 PrivacyService.eraseData 查同一 shard，否则功能语义反转（错误擦除）——spec §3-B 具名验收点。 ——
  { id: 'src/privacy/legal-hold-service.ts#LegalHoldService::ctor-param::LegalHoldService::db', file: 'src/privacy/legal-hold-service.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '构造器注入 db；须与 PrivacyService.eraseData 建时用 resolver.dbForTenant(tenantId) 查同一 shard，否则多 shard 下 legal hold 与 erase 语义反转（错误擦除）——2-shard 集成测试专项验（spec §3-B）' },

  // —— #4 NudgePushBridge（app.ts:328 注入 host db，nudge-push-bridge.ts:67/75 按事件 tenantId 用固定 db）——
  //     A0 反向扫描证实的典型 deps-prop 藏 sink 案例：deps.db 非当场传参，是长期捕获。 ——
  { id: 'src/server/services/nudge-push-bridge.ts#NudgePushBridge::ctor-param::NudgePushBridge::deps.db', file: 'src/server/services/nudge-push-bridge.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: '构造器 deps 对象里的 db（NudgePushBridgeDeps.db）——app.ts:328 注入固定 host db，按事件 tenantId 应改 resolver.dbForTenant(tenantId) 而非固定 db，否则非 home 租户静默漏推（spec §3-A0 #4 点名案例）' },
  { id: 'src/server/services/nudge-push-bridge.ts#NudgePushBridgeDeps::deps-prop::NudgePushBridgeDeps::db', file: 'src/server/services/nudge-push-bridge.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'NudgePushBridgeDeps 接口的 db 属性签名——契约层声明，随实现一并下沉' },
  { id: 'src/server/services/nudge-push-bridge.ts#NudgePushBridge.deliver::factory-indirect::MobileDeviceService::tx', file: 'src/server/services/nudge-push-bridge.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'deliver 方法内用固定 db 建 MobileDeviceService(tx)——同一固定-db-按事件-tenantId 问题，随 deps.db 一并下沉' },
  { id: 'src/server/services/nudge-push-bridge.ts#NudgePushBridge.deliver::factory-indirect::NotificationPreferenceStore::tx', file: 'src/server/services/nudge-push-bridge.ts', category: 'longlived-root-capture', disposition: 'resolver', wiringStatus: 'planned', note: 'deliver 方法内用固定 db 建 NotificationPreferenceStore(tx)——同上' },

  // —— #5 main-observability-worker.ts 独立入口（spec §5.1，绕过 app.ts 装配）——
  //     disposition = per-shard-worker：spec §5.1 三选一推荐①独立进程也建 resolver + 每 shard 建 pipeline/worker。 ——
  { id: 'src/main-observability-worker.ts#<module>::factory-indirect::ObservabilityPipelineService::db', file: 'src/main-observability-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '独立入口直接 createDatabase(config) 建 db 传 ObservabilityPipelineService，不经 createApp/buildResolver；spec §5.1 推荐①独立进程也建 resolver + 每 shard 建 pipeline（observability outbox 是 per-shard 数据，各 shard 各扫各的），非迁协调库' },
  { id: 'src/main-observability-worker.ts#<module>::factory-indirect::ObservabilityWorkerMonitorServer::deps.db', file: 'src/main-observability-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '监控 server 的 deps.db——随独立入口整体走 per-shard-worker 处置' },

  // —— #6 AuthService mixed-scope（spec §4.1：同时含平台级定位 + 租户级写，状态机见 spec §4.1）——
  { id: 'src/identity/auth-service.ts#AuthService::ctor-param::AuthService::tx', file: 'src/identity/auth-service.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: '构造器注入 tx；authQueryUserByEmail(login/register 前) 是无 tenantId 的全局定位查（走 coordinator identity directory），register 内建 user/subscription/quota/identity 是租户级写（走 resolver.dbForTenant）——spec §4.1 定死的 PENDING→ACTIVE reservation 状态机，非简单二选一' },
  { id: 'src/identity/auth-service.ts#AuthService.cleanupExpired::capture::AuthService.cleanupExpired::tx', file: 'src/identity/auth-service.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'cleanupExpired 闭包捕获 tx——随构造器 tx 一并 mixed-scope 处置' },
  { id: 'src/identity/auth-service.ts#AuthService.cleanupExpiredTokens::factory-indirect::cleanupExpired::tx', file: 'src/identity/auth-service.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'cleanupExpiredTokens 转发 tx 给 cleanupExpired——同上' },
  { id: 'src/identity/auth-service.ts#AuthService.register::factory-indirect::IdentityService::tx', file: 'src/identity/auth-service.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'register 内建 IdentityService(tx)——spec §4.1 状态机第②步「tenant shard 幂等初始化」的一部分，走 resolver.dbForTenant(tenantId)（tenantId 已在此步生成）' },
  { id: 'src/identity/auth-service.ts#AuthService.register::factory-indirect::syncPlanToQuota::tx', file: 'src/identity/auth-service.ts', category: 'longlived-root-capture', disposition: 'mixed-scope', wiringStatus: 'planned', note: 'register 内 syncPlanToQuota(tx,...) 写 quota——同上，租户级写' },

  // —— #7 全局 worker/timer sink 类（spec §3-A0 #7 + §5.2，全在 app.ts 装配期绑 host db/root tx）——
  //     disposition = per-shard-worker：spec §5.2 逐项处置——per-shard fan-out 跑（对 resolver.allShardDbs() 各跑一遍）。 ——
  { id: 'src/persona-core/runtime-recovery-worker.ts#RuntimeRecoveryWorker::ctor-param::RuntimeRecoveryWorker::db', file: 'src/persona-core/runtime-recovery-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'app.ts:338 注入 host db；runtime-recovery-worker.ts:89 包 SingleDbResolver，分片后只恢复 home shard persona——spec §5.2 逐项处置：改接 resolver，run 时 for (const db of resolver.allShardDbs()) 各 shard 各自恢复' },
  { id: 'src/persona-core/runtime-recovery-worker.ts#RuntimeRecoveryWorker.flushInternal::factory-indirect::SingleDbResolver::db', file: 'src/persona-core/runtime-recovery-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'flushInternal 内包 SingleDbResolver(db)——随构造器 db 一并 per-shard-worker 处置，Plan 1+ 改接真 resolver' },
  { id: 'src/billing/settlement-reconciliation-worker.ts#SettlementReconciliationWorker::ctor-param::SettlementReconciliationWorker::tx', file: 'src/billing/settlement-reconciliation-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'app.ts:353 注入 host db；settlement-reconciliation-worker.ts:79 reconcileTenants 跨租户扫描——spec §5.2 per-shard fan-out 跑（各 shard 各自 reconcile 本 shard 租户）' },
  { id: 'src/billing/settlement-reconciliation-worker.ts#SettlementReconciliationWorker.flushInternal::factory-indirect::SettlementReconciliationService::tx', file: 'src/billing/settlement-reconciliation-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'flushInternal 内建 SettlementReconciliationService(tx)——随构造器 tx 一并处置' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorker::ctor-param::DualWriteFlushWorker::opts.db', file: 'src/workers/dual-write-flush-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'app.ts:367 注入 host db；dual-write-flush-worker.ts:42 只 flush home shard persona ledger outbox——spec §5.2 per-shard fan-out 跑' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorkerOptions::deps-prop::DualWriteFlushWorkerOptions::db', file: 'src/workers/dual-write-flush-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'DualWriteFlushWorkerOptions 接口的 db 属性签名——契约层声明，随实现一并处置' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorker::field-decl::DualWriteFlushWorker::ledger.db', file: 'src/workers/dual-write-flush-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '内部 ledger.db 字段——随构造器 db 一并处置' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorker::assignment::this.ledger::db', file: 'src/workers/dual-write-flush-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '构造器体内 this.ledger = new SqliteEventLedger(db) 赋值——同上' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorker::factory-indirect::SqliteEventLedger::db', file: 'src/workers/dual-write-flush-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: '构造 SqliteEventLedger(db)——同上' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorker.flush::factory-indirect::flushOutbox::db', file: 'src/workers/dual-write-flush-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'flush 方法内转发 db 给 flushOutbox(db,...)——同上' },
  { id: 'src/perception/media/media-retention-worker.ts#MediaRetentionWorker::ctor-param::MediaRetentionWorker::tx', file: 'src/perception/media/media-retention-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'app.ts:558 注入 host db；media-retention-worker.ts:70/108 全局扫过期媒体引用——GDPR Art.17 最优先项：非 home shard 媒体擦除停止=擦除义务缺失。spec §5.2 per-shard fan-out 跑，每 shard 各扫各的过期媒体，不可延后' },
  { id: 'src/perception/media/media-retention-worker.ts#MediaRetentionWorker.flushOnce::factory-indirect::runMediaRetention::tx', file: 'src/perception/media/media-retention-worker.ts', category: 'global-worker', disposition: 'per-shard-worker', wiringStatus: 'planned', note: 'flushOnce 内转发 tx 给 runMediaRetention(tx,...)——随构造器 tx 一并处置，同 GDPR 优先级' },
];
