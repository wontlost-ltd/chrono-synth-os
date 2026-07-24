# 租户分片 Phase 0 · Plan 1c（Auth mixed-scope + coordinator identity directory）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐 task 实现。步骤用 checkbox（`- [ ]`）跟踪。
>
> **第 2 轮修订**：采纳 Codex 独立复审 57/100 退回的 8 项确认缺陷——① operationId 确定性重入（非随机）② 老用户 login 致命兼容→回填迁移 ③ shard 原子完成标记(bootstrap ledger) ④ CAS 失败不签发 token ⑤ 目录=定位器、shard is_revoked=权威（消双写一致性依赖）⑥ revoke-by-hash 接口 ⑦ 目录不存 shardId（tenantId 纯函数派生，消 `shardIdForTenant()` 幽灵方法 + 修 fake）⑧ 6 迁移同步点全显式。
>
> **第 3 轮修订**：采纳 Codex 复审 69/100 退回的 5 项——① **canonical identity**：`reserveTenant` 返回读回行的 canonical `(tenantId, userId)`；reservation 表存 userId；重试用 canonical 身份不重生。② **bootstrap ledger 粒度**：主键 `(tenant_id, operation_id)`。③ **email canonicalization**：单一 `canonicalizeEmail` 贯穿。④ Stripe 幂等（本轮发现不可执行，见第 4 轮）。⑤ **directory 写失败可用性**。⑥ **id-generator seam 修 fake**。⑦ 迁移同步点精确化（legacy fixture 两数组）。
>
> **第 4 轮修订（安全关键）**：采纳 Codex 复审 64/100 退回的 3 阻断——① **register 账号接管漏洞（致命）**：第 3 轮 `operationId=hash(email)` 使**任何人**再次 `register(victim@email, 任意密码)` 得同 operationId → `reservedByUs` 为真 → 走 COMPLETE 快路 → 不校验密码直接为 victim 签 token。**根治：register 绝不认证。** email 已 **ACTIVE** → 一律 `AUTH_EMAIL_EXISTS`(409)、绝不签 token（保持现状语义）。**幂等重试改由客户端 `Idempotency-Key` header 提供 operationId**（非 email 派生）：有 key 且指向本次 PENDING reservation 才幂等续做；无 key 时重复 register 一律 409（ACTIVE）或 `AUTH_REGISTRATION_IN_PROGRESS`（PENDING，不签 token）。PENDING 续做也须 idempotency-key 证明属原请求，仅知 email 不能接管。② **Stripe 不可执行**：`createCustomer(config,email,tenantId)` 现签名**不收 idempotencyKey**、`transaction(fn:()=>T)` **同步且拒 Promise**——不能把 Stripe HTTP 放进 DB 事务。**改：Stripe 在事务外先做**（`createCustomer` 加 idempotencyKey 形参 + 传 `stripe.customers.create(params,{idempotencyKey})`）→ 得稳定 customerId → 再开短 shard 同步事务写 DB；DB 失败重试用同 key 复用同 customer。须显式改 `stripe-client.ts` + 签名 + 测试。③ **changeEmail 跨库窗口**：coordinator 目录改了但 shard users.email 未改（或反）→ login 新 email 命中目录 tenant→shard 查新 email 查不到→永久登不上。**改：changeEmail 也走小状态机**——coordinator reserve 新 email PENDING → shard 事务改 users.email → coordinator 激活新 email+删旧映射 → 未完成保留旧 ACTIVE 映射（不锁死）+ 恢复 worker 凭 shard canonical email 补激活。另：email UPDATE 是**显式数据规范化**（非「完全等价现状」）——迁移说明须标明 email 成为 canonical login 标识、原展示大小写不保留、需展示格式另设 `display_email`。

**Goal:** 把「无 tenantId 的全局定位 + 租户级写」这类 mixed-scope 入口（register/login/SSO/SCIM/refresh/api-key）切到 coordinator identity directory 定位后再到正确 shard 读写，落地 spec §4.1 的 `PENDING → ACTIVE` reservation 状态机（唯一真跨库写序列），**且升级前的历史用户无缝可用**。

**Architecture:** coordinator 上建 `tenant_identity_directory`（`lookup_kind ∈ {email,refresh_token_hash,api_key_hash}` × `lookup_value` → `tenant_id` 全局反查 + `PENDING/ACTIVE`）。

关键设计决策（回应 Codex）：
- **目录=定位器，权威在 shard**：目录项只回答「这个 email/token/key 属哪个 tenant」；账号是否有效（密码、is_revoked、过期）永远以 `dbForTenant(tenantId)` 的 shard 内行为权威真源。故目录与 shard 的「双写」不需要原子/2PC——目录项过期/多余只导致「定位到一个 shard 后在 shard 上验证失败」（安全的拒绝），绝不导致越权。撤销以 shard `is_revoked` 为准，目录项清理是尽力而为的垃圾回收（清晚了不影响正确性，因 shard 已拒）。
- **目录不存 shardId**：shardId 是 `tenantId` 的纯函数（`shardIdForTenant(tenantId, shardIds)`，`shard-hash.ts`，`dbForTenant` 内部即用它）。存 shardId 是会漂移的冗余，故目录只存 `tenant_id`，路由永远靠 `resolver.dbForTenant(tenantId)`。**无需给 resolver 加 `shardIdForTenant()` 方法**。
- **register 绝不认证 + 客户端幂等键（第 4 轮，根治账号接管）**：register 是**建新账号**，永不为已存在账号签 token。逻辑：
  - reserve 前先 `resolveByEmail(canonEmail)`：若 **ACTIVE** → `AUTH_EMAIL_EXISTS`(409)、绝不签 token（与现状 409 语义一致，堵住「重复 register 接管」）。
  - `operationId` **来自客户端 `Idempotency-Key` header**（非 email 派生）；缺 header 时生成一次性随机 opId（该请求专属，无跨请求幂等）。
  - reserve：`dirCmdReserve(tenantId, userId, operationId, 'email', canonEmail, 'PENDING')` ON CONFLICT DO NOTHING → 读回既存行；`reservedByUs = 读回行.operation_id === 本次 operationId`。**因 opId 现来自私有幂等键（非公开 email），他人无法伪造同 opId**——只有持同一 Idempotency-Key 的原客户端重试才 `reservedByUs:true`。
  - `reservedByUs:false` 且读回行 ACTIVE → `AUTH_EMAIL_EXISTS`；`reservedByUs:false` 且 PENDING（他人在建同 email，罕见并发）→ `AUTH_REGISTRATION_IN_PROGRESS`（不签 token，客户端稍后重试或换 email）。
  - `reservedByUs:true` → 用读回行 canonical `(tenantId, userId)` 续做（首次即刚插的、重试即上次持久化的），绝不重生身份、绝不用本次随机 tenantId 写 shard。
  - reservation 表存 `user_id` 供重试复用。**register 从不校验密码去发既存账号 token——已 ACTIVE 就 409，PENDING 就续做本次注册，二者都不构成认证旁路。**
- **shard bootstrap 完成标记（第 3 轮：per-operation 粒度）**：register 在 `dbForTenant(tenantId)` 的**单个事务**内写 user/subscription/quota/identity **加一行 `tenant_bootstrap(tenant_id, operation_id, status='COMPLETE')`，主键 `(tenant_id, operation_id)`**。CAS activate 与恢复 worker 以**匹配 operationId 的 COMPLETE 行**为判据（非「user 行存在」也非「tenant 有任一 COMPLETE」——SCIM/OIDC 向已 COMPLETE 的 tenant 加用户时，本次新 reservation 有独立 operationId，旧 COMPLETE 不能误证本次完成）。
- **CAS 失败不签发 token**：`activateTenant` 返 false（本次前已被同一 reservation 的重试激活）后读回目录行；因 `reservedByUs` 已在前置证明本次 opId 属己（canonicalTenantId 来自本次 reservation 读回行、opId 私有不可伪造），此时 `tenantId===canonicalTenantId && status==='ACTIVE'` 即可确证本次 reservation 已激活→签发；否则抛 `AUTH_REGISTRATION_RETRY`。（opId 不必再比：`reservedByUs` 前置门已保证 canonicalTenantId 对应本次 opId；文档与伪代码统一为「tenantId+ACTIVE」两元，不再写「三元」。）
- **email canonicalization（第 3 轮）**：单一纯函数 `canonicalizeEmail(email) = email.trim().toLowerCase()`（`src/identity/email-canonical.ts` 新建）贯穿：目录 `lookup_value`、users.email 写入、**回填迁移的历史 email**、login/register/SSO/SCIM 的 email 派生——全部先 canonicalize。回填 SQL 对历史 `users.email` 也 `LOWER(TRIM(...))` 后写入目录，且**同步把 users.email 归一化**（迁移内 UPDATE），否则 login 派生的 canonical 值与 shard 内原值大小写不符→查不到。
- **Stripe 事务外幂等（第 4 轮，改正不可执行方案）**：`transaction(fn:()=>T)` 同步且拒 Promise，`createCustomer` 现不收 idempotencyKey——故**Stripe 在 DB 事务外先做**：① 给 `createCustomer(config,email,tenantId,idempotencyKey?)` 加形参，内部 `stripe.customers.create(params, { idempotencyKey })`；② register 在开 shard 事务**前** `await createCustomer(..., operationId)` 得稳定 customerId（重试同 operationId→Stripe 返同 customer，不重复建）；③ 再开**短同步** shard 事务写 user/subscription(customerId)/quota/identity/bootstrap；④ 若重试且 shard 已 COMPLETE，读回既存 customerId、跳过 Stripe 与重建。外部 HTTP 不进事务=不拉长持锁、不需回滚外部副作用。
- **directory 写失败可用性（第 3 轮）**：`recordActiveLookup`（token/key）ON CONFLICT 后**读回校验 tenantId 属己**（冲突不假定同映射）；目录写失败（异常）时**不返回凭据**（token/key 签发前先确保目录 locator 写成功），避免「发了凭据但定位不到」。

register/SSO 自生成 tenantId 序列：`resolveByEmail ACTIVE→409；opId 来自 Idempotency-Key（缺则一次性随机）；reserve 读回 canonical (tenantId,userId)+reservedByUs；若 reservedByUs 且 shard 未 COMPLETE：先事务外 Stripe(idempotencyKey=opId) 得 customerId → 再开短同步 shard 事务写租户数据(含 customerId)+bootstrap(tenant_id,operation_id) COMPLETE → CAS PENDING→ACTIVE → 仅本次 reservation ACTIVE 才签发 token`。login/refresh/SSO/OIDC/SCIM/api-key 只认 `ACTIVE` 目录项定位 tenant，再到 shard 权威验证。恢复 worker 凭匹配 operationId 的 bootstrap COMPLETE 补 ACTIVE、绝不取消 PENDING。**新增回填迁移**把升级前 users/api_keys/refresh_tokens 写成 ACTIVE 目录项（email 归一化），老用户无缝。单库下 `coordinatorDb() ≡ dbForTenant`，行为等价现状。

**Tech Stack:** TypeScript、`@wontlost-ltd/schema-dsl`（DSL 迁移）、kernel query/command 工厂 + executor、`TenantDbResolver`、`shardIdForTenant`（`src/storage/shard-hash.ts` 纯函数）、`FakeMultiShardResolver`（2-shard + 独立 coordinator）、node:test。

## Global Constraints

- **零-LLM 内核铁律**：纯数据路由 + 目录表改造，绝不引入 LLM。
- **绝不破坏用户空间（铁律）**：升级前用户/token/api-key 必须继续可用——回填迁移（Task 2）是硬前置，其后所有「目录硬前置定位」的 Task 才允许合入。
- **目录=定位器、shard=权威**：目录项只定位 tenant；有效性（密码/is_revoked/过期）永远 shard 权威。目录↔shard 无需原子双写（撤销留孤儿=安全，因 shard 权威拒）。但**签发凭据前须确保目录 locator 已成功写入**（否则发了 token/key 却定位不到=可用性 bug，第 3 轮 Codex #5）。
- **id-generator seam（第 3 轮，为可测性）**：`AuthService`/`SsoUserService` ctor 注入可选 `idGenerator: { tenantId(): string; userId(): string }`（默认 `() => 'tenant_'+randomUUID()` / `randomUUID`）。测试注入确定性 generator 并把这些 tenantId 预登记进 `FakeMultiShardResolver.tenantToShard`——真 register 流程（自生成 id）才能在 fake 上跑（fake 按静态映射，未登记 tenantId 抛错）。
- **email 唯一 canonical**：`canonicalizeEmail = trim+lowercase`，贯穿目录/users.email/回填/派生，单一真源函数 `src/identity/email-canonical.ts`。
- **隔离双重约束**：定位得 tenantId 后，租户级读写 ① `resolver.dbForTenant(tenantId)` + ② SQL `WHERE tenant_id=?`（或父归属 JOIN）。目录级全局反查走 `resolver.coordinatorDb()`。
- **状态机 spec 定死（§4.1）**：PENDING→ACTIVE、不 2PC、email 唯一挡并发、只认 ACTIVE、**恢复 worker 绝不自动取消 PENDING**。operationId 确定性、bootstrap 完成标记、CAS 失败不发 token 是本轮为落地状态机而定的实现约束。
- **单库零回归**：`SingleDbResolver` 三方法返同一 db，现有 auth-api/sso/scim 测试仍绿。回填迁移在单库下也跑（把本库 users→本库目录 ACTIVE），login 改造后老用户仍通。
- **tenant-bound seam 不破**：写租户数据用 `new IdentityWriter(tenantId, tx)`（Plan 1b seam）。
- **fail-closed 不放开**：不碰 `assertShardingActivationAllowed`/verified 门（Plan 3）。多-shard 行为全靠 `FakeMultiShardResolver` 单测。
- **迁移同步 6 处（第 3 轮精确化，核验真实 parity 测）**（记忆 [[schema-dsl-migration-sync-points]]，schema-simple 类）：① 迁移文件本体 ② `server-simple/index.ts` 的 export/import/`SERVER_SIMPLE_MIGRATIONS` 数组（三子处）③ `version-map.ts` 的 `VERSION_MAP` ④ `src/test/integration/fixtures/legacy-migrations.ts` 的 `LEGACY_SQLITE_MIGRATIONS`（parity 测 `.map(m=>m.version)` 逐版本比对，`schema-dsl-sqlite-parity.test.ts:163`/`:102`）⑤ 同文件 `LEGACY_POSTGRES_MIGRATIONS`（`schema-dsl-pg-parity.test.ts:165`/`:174`）⑥ 重建 `packages/schema-dsl/dist`。**parity 测无独立硬编码期望计数数组、无 VERSION_MAP range 断言**（第 3 轮核验删除这两个不存在的声明）。**Task 1/2 每条迁移必须在同一 commit 内同步全 6 处**（`git add` 含 `fixtures/legacy-migrations.ts` + `dist`），不得留「CI 报再补」。号：Task 1 表迁移 sqlite `v123`/postgres `v125`；Task 2 回填 sqlite `v124`/postgres `v126`（避开 server-raw v119-v122，PostgreSQL +2 偏移一致）。
- **接口签名统一改造**：`AuthService`/`SsoUserService`/`ScimProvisioningService` ctor 从裸 `tx` → `TenantDbResolver`；`registerAuth` 从裸 `db` → `resolver`；`ApiKeyService.revoke` 增按 hash 撤销的能力（见 Task 6）。所有构造点同步（`routes/auth.ts:214/280`、`app.ts:753`、`auth-sso.ts:95`、`auth-oidc.ts:79`、`app-services.ts:93`、`app.ts:242`、测试）。

---

## File Structure

- **迁移**：`packages/schema-dsl/src/migrations/server-simple/v123.ts`（`tenant_identity_directory`）+ `v124.ts`（回填 + `tenant_bootstrap` 标记表）+ 同步 `server-simple/index.ts` + `version-map.ts` + parity fixture。
- **kernel 工厂**：`packages/kernel/src/domain/identity/directory-queries.ts`（insert-on-conflict PENDING / CAS ACTIVE / query by lookup / query pending-before / delete-by-lookup / backfill-select）+ `bootstrap-queries.ts`（mark COMPLETE / query by tenant）。
- **executor**：`src/storage/executors/directory-executors.ts` + `bootstrap-executors.ts` + 注册进 `src/storage/executors/index.ts`。
- **directory 服务**：`src/identity/tenant-identity-directory.ts`。
- **改造消费者**：`auth-service.ts`、`sso-user-service.ts`、`scim-provisioning-service.ts`、`server/plugins/auth.ts`、`billing/api-key-service.ts`。
- **恢复 worker**：`src/identity/tenant-reservation-recovery.ts`。
- **过渡收口**：`user-email-directory-service.ts`、`scim-tenant-directory.ts`。
- **测试**：`src/test/unit/auth-mixed-scope-sharding.test.ts`（新）+ `directory-executors.test.ts` + `tenant-identity-directory.test.ts` + `tenant-reservation-recovery.test.ts` + `src/test/integration/auth-api.test.ts`（回归 + 并发 register + **老用户回填后可 login**）。

---

## Task 1: coordinator 目录表迁移 `tenant_identity_directory`

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-simple/v123.ts`
- Modify: `packages/schema-dsl/src/migrations/server-simple/index.ts`（export/import/数组三子处）
- Modify: `packages/schema-dsl/src/version-map.ts`
- Modify: `src/test/integration/fixtures/legacy-migrations.ts`（`LEGACY_SQLITE_MIGRATIONS` + `LEGACY_POSTGRES_MIGRATIONS` 各加对应版本 raw 迁移，供 parity `.map(m=>m.version)` 逐版本比对）
- Test: `src/test/unit/migrations.test.ts` + `src/test/integration/schema-dsl-{sqlite,pg}-parity.test.ts`

**Interfaces:**
- Produces: 表 `tenant_identity_directory`：`tenant_id TEXT NOT NULL`、`user_id TEXT`（第 3 轮：canonical userId，供 register 重试复用身份不重生；token/key 项可 NULL）、`operation_id TEXT NOT NULL`、`lookup_kind TEXT NOT NULL CHECK IN ('email','refresh_token_hash','api_key_hash')`、`lookup_value TEXT NOT NULL`、`status TEXT NOT NULL CHECK IN ('PENDING','ACTIVE')`、`created_at INTEGER NOT NULL`、`updated_at INTEGER NOT NULL`。约束 `UNIQUE(lookup_kind, lookup_value)`（全局唯一→挡并发 register）；索引 `idx_tid_tenant (tenant_id)`。**无 shard_id 列**（shardId 由 tenantId 纯函数派生）。

- [ ] **Step 1: 照抄现有迁移形态**

Read `packages/schema-dsl/src/migrations/server-simple/v078.ts`（state+CHECK 枚举）、`v108.ts`（unique/partial-unique）、目录里最近一条 schema-simple 迁移，照抄 `defineMigration`/builder 的确切 API 与命名风格（变量名 `v123_tenant_identity_directory`）。

- [ ] **Step 2: 写 v123.ts**

按 Interfaces 的列/约束写。CHECK 与 UNIQUE 用 v078/v108 已在 SQLite+PG 两 renderer 验证过的写法，**不自创 builder 方法名**。

- [ ] **Step 3: 同步 index.ts 三子处**

`export {...} from './v123';` + `import {...} from './v123';` + `SERVER_SIMPLE_MIGRATIONS` 数组末尾加 `v123_tenant_identity_directory,`（照抄 v118 那条位置/风格）。

- [ ] **Step 4: 同步 version-map.ts**

`VERSION_MAP` 尾加（postgres v125，比 sqlite 高 2，照抄末条 `v122_github_draft_published` 的别名格式）：
```ts
{ canonical: 'v123_tenant_identity_directory',
  aliases: { postgres: 'v125_tenant_identity_directory', 'sqlite-sql': 'v123_tenant_identity_directory' },
  classification: 'schema-simple' },
```

- [ ] **Step 5: 同步 legacy fixture 两数组**

Read `src/test/integration/fixtures/legacy-migrations.ts`，照现有末条 raw 迁移风格，在 `LEGACY_SQLITE_MIGRATIONS` 加 `{ version:'v123_tenant_identity_directory', sql: <SQLite DDL> }`、`LEGACY_POSTGRES_MIGRATIONS` 加 `{ version:'v125_tenant_identity_directory', sql: <PG DDL> }`（DDL 与 DSL 渲染等价，parity 正是断言二者一致）。

- [ ] **Step 6: 重建 dist + 跑迁移测试**

Run: `npm run build --workspace=@wontlost-ltd/schema-dsl 2>&1 | tail -5`
Run: `npx tsx --test src/test/unit/migrations.test.ts src/test/integration/schema-dsl-sqlite-parity.test.ts src/test/integration/schema-dsl-pg-parity.test.ts 2>&1 | tail -30`
Expected: 全绿。**若报 missing/count-mismatch/fixture 不符** → 在**本 commit 内**补齐指向的同步点（禁「留 CI 报再补」）。反复跑到三测全绿。

- [ ] **Step 7: Commit**

```bash
git add packages/schema-dsl/src packages/schema-dsl/dist src/test/integration/fixtures/legacy-migrations.ts
git commit -m "feat(shard): coordinator tenant_identity_directory 表迁移(email/token/key→tenant + PENDING/ACTIVE，6 同步点全补)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `tenant_bootstrap` 标记表 + 历史数据回填迁移（向后兼容硬前置）

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-simple/v124.ts`（建 `tenant_bootstrap` 表 + 回填 directory + 归一化 users.email）
- Modify: `index.ts`/`version-map.ts`/`fixtures/legacy-migrations.ts` 两数组（同 Task 1 全 6 同步点）
- Test: `src/test/integration/directory-backfill.test.ts`（新建）

**Interfaces:**
- Produces:
  - 表 `tenant_bootstrap`：`tenant_id TEXT NOT NULL`、`operation_id TEXT NOT NULL`、`status TEXT NOT NULL CHECK IN ('COMPLETE')`、`created_at INTEGER NOT NULL`，**主键 `PRIMARY KEY (tenant_id, operation_id)`**（第 3 轮：per-operation 粒度——SCIM/OIDC 向已有 tenant 加用户是独立 operation，不能靠 tenant 级旧 COMPLETE 误证本次完成）。shard 内表。
  - 回填 SQL（幂等）：`users.email → (tenant_id, 'email')`（**email 经 `LOWER(TRIM(email))` 归一化写入 lookup_value**）、`api_keys.key_hash → (tenant_id, 'api_key_hash')`、`refresh_tokens JOIN users` → `(tenant_id, 'refresh_token_hash')`，全部 `INSERT INTO tenant_identity_directory (tenant_id, user_id, operation_id, lookup_kind, lookup_value, status, ...) VALUES (..., 'ACTIVE', ...) ON CONFLICT(lookup_kind,lookup_value) DO NOTHING`（email 项 user_id=users.id；token/key 项 user_id 可 NULL）。
  - **同步归一化 users.email**：`UPDATE users SET email = LOWER(TRIM(email))`（否则 login 派生的 canonical email 与 shard 内原大小写不匹配→老用户查不到，第 3 轮 Codex 新问题#1）。归一化后若产生重复 email（历史脏数据）→ 迁移前置检测：先 `SELECT LOWER(TRIM(email)), COUNT(*) ... GROUP BY 1 HAVING COUNT(*)>1`，有冲突则迁移抛错停止（fail-closed，人工清理后再跑；不静默丢数据）。
  - **单库下**（升级路径）users/directory 同库，回填直接跑；多库下本迁移在单库/home 库内回填本库数据，**多库跨 shard 汇总到 coordinator 留激活部署工具**（该工具是未来解除 fail-closed 的硬门，标注 known-limitation——Phase 0 fail-closed 仍挡多库，只有单库真跑，此降级可接受，Codex 复审确认）。

- [ ] **Step 1: 写回填迁移测（红）**

`directory-backfill.test.ts`：内存 sqlite 先跑到 v123（表存在、空），手插 3 个老 user（含一个**大小写混合 email** 如 `User@Example.com`）+ 2 个 api_key + 1 个 refresh_token（无任何目录项，模拟升级前）→ 跑 v124 → 断言：① directory 有 6 条 ACTIVE 项，operation_id='backfill'；② **email 项 lookup_value 全小写**（`user@example.com`）且对应 **users.email 也被归一化为小写**（login 派生一致的关键）；③ email 项 user_id=对应 users.id。再跑一次 v124（幂等）→ 无重复、无报错。再造一条：两 user email 归一化后冲突（`A@x.com`/`a@x.com`）→ 跑 v124 **抛错停止**（fail-closed，不静默丢）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（v124 未建）。

- [ ] **Step 3: 写 v124.ts**

建 `tenant_bootstrap` 表（PK `(tenant_id, operation_id)`）+ 冲突前置检测（`GROUP BY LOWER(TRIM(email)) HAVING COUNT>1` 有则抛）+ `UPDATE users SET email=LOWER(TRIM(email))` + 三条回填 `INSERT ... SELECT ... ON CONFLICT DO NOTHING`（email 项 SELECT `LOWER(TRIM(email))`）。SQLite/PG 两 renderer 都支持 `ON CONFLICT DO NOTHING` 与 `LOWER`/`TRIM`；照抄现有含 data-migration 的迁移写法，若 DSL 不支持 `INSERT SELECT` 则用 renderer raw SQL 段（先 Read 现有数据回填迁移确认 DSL 能力）。同步 index/version-map/legacy fixture 两数组（全 6 处）。重建 dist。

- [ ] **Step 4: 跑测试确认通过 + 迁移全门**

Run: `npm run build --workspace=@wontlost-ltd/schema-dsl 2>&1 | tail -5`
Run: `npx tsx --test src/test/integration/directory-backfill.test.ts src/test/unit/migrations.test.ts src/test/integration/schema-dsl-{sqlite,pg}-parity.test.ts 2>&1 | tail -30`
Expected: 全绿（含幂等 + email 归一化 + 冲突 fail-closed）。

- [ ] **Step 5: Commit**

```bash
git add packages/schema-dsl/src packages/schema-dsl/dist src/test/integration/directory-backfill.test.ts src/test/integration/fixtures/legacy-migrations.ts
git commit -m "feat(shard): tenant_bootstrap(PK tenant+op) + 历史回填 directory(email 归一化,冲突 fail-closed)——老用户零中断

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 目录 + bootstrap kernel 工厂 + executor

**Files:**
- Create: `packages/kernel/src/domain/identity/directory-queries.ts`、`bootstrap-queries.ts`（+ 导出桶）
- Create: `src/storage/executors/directory-executors.ts`、`bootstrap-executors.ts` + 注册 `src/storage/executors/index.ts`
- Test: `src/test/unit/directory-executors.test.ts`

**Interfaces:**
- Produces（照抄 `api-key-queries.ts`/`api-key-executors.ts` 风格）：
  - `dirCmdReserve({ tenantId, userId, operationId, lookupKind, lookupValue, status, now })` → `INSERT INTO tenant_identity_directory (tenant_id, user_id, operation_id, ...) VALUES (...) ON CONFLICT(lookup_kind, lookup_value) DO NOTHING`（reserve 用 status='PENDING' 带 userId；record token/key 用 'ACTIVE' userId 可 NULL）。
  - `dirCmdActivate({ operationId, lookupKind, lookupValue, now })` → `UPDATE ... SET status='ACTIVE', updated_at=? WHERE lookup_kind=? AND lookup_value=? AND operation_id=? AND status='PENDING'`（CAS；rowsAffected 判定）。
  - `dirQueryByLookup(lookupKind, lookupValue)` → `SELECT tenant_id, user_id, status, operation_id FROM tenant_identity_directory WHERE lookup_kind=? AND lookup_value=? LIMIT 1`（**返 user_id**，供 reserve 读回 canonical 身份）。
  - `dirQueryPendingBefore(cutoff)` → `SELECT tenant_id, user_id, operation_id, lookup_kind, lookup_value FROM tenant_identity_directory WHERE status='PENDING' AND updated_at < ?`。
  - `dirCmdDeleteByLookup(lookupKind, lookupValue)` → `DELETE ... WHERE lookup_kind=? AND lookup_value=?`（撤销时清目录，尽力而为）。
  - `bootCmdMarkComplete({ tenantId, operationId, now })` → `INSERT INTO tenant_bootstrap (tenant_id, operation_id, status, created_at) VALUES (..., 'COMPLETE', ?) ON CONFLICT(tenant_id, operation_id) DO NOTHING`（per-operation）。
  - `bootQueryByOperation(tenantId, operationId)` → `SELECT tenant_id, operation_id, status FROM tenant_bootstrap WHERE tenant_id=? AND operation_id=? LIMIT 1`（**按 operationId 匹配**——非 tenant 级查，SCIM/OIDC 新 reservation 不被旧 COMPLETE 误证）。

- [ ] **Step 1: 写 executor 单测（红）**

内存 sqlite + 迁移到 v124。测：reserve PENDING（带 userId）→ `dirQueryByLookup` status=PENDING 且 **user_id 读回正确**；**重复 reserve 同 lookup 不同 tenantId/userId（ON CONFLICT DO NOTHING）→ 不报错、行不变、operation_id/user_id 仍第一次的**（幂等，非撞错——canonical 身份来自读回）；`dirCmdActivate` 正确 operationId → rowsAffected=1、status=ACTIVE；**错 operationId activate → rowsAffected=0**（CAS 防他人激活）；已 ACTIVE 再 activate → 0；`bootCmdMarkComplete` 后 `bootQueryByOperation(tenantId, operationId)` status=COMPLETE、**不同 operationId 查同 tenant → null**（per-operation 粒度）、重复 mark 幂等；`dirCmdDeleteByLookup` 后查返 null。

- [ ] **Step 2: 跑测试确认失败** — `npx tsx --test src/test/unit/directory-executors.test.ts`，Expected FAIL。

- [ ] **Step 3: 写工厂 + executor** — 按 Interfaces SQL 实现，注册 index.ts。

- [ ] **Step 4: 跑测试确认通过** — Expected PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src src/storage/executors/directory-executors.ts src/storage/executors/bootstrap-executors.ts src/storage/executors/index.ts src/test/unit/directory-executors.test.ts
git commit -m "feat(shard): 目录+bootstrap kernel 工厂+executor(reserve ON CONFLICT/CAS activate/mark complete/delete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `TenantIdentityDirectory` 协调库门面

**Files:**
- Create: `src/identity/tenant-identity-directory.ts`
- Test: `src/test/unit/tenant-identity-directory.test.ts`

**Interfaces:**
- Consumes: Task 3 executor、`TenantDbResolver.coordinatorDb()`、`crypto`（sha256 派生 operationId）。
- Produces（`TenantIdentityDirectory`，ctor `(private readonly resolver: TenantDbResolver)`）：
  - `static deriveOperationId(email): string` — `'reg:' + sha256Hex(canonicalizeEmail(email))`（确定性；同 canonical email 恒同值）。
  - `reserveTenant({ tenantId, userId, email }): { operationId; reservedByUs: boolean; canonicalTenantId: string; canonicalUserId: string }` — 派生 operationId；`dirCmdReserve` PENDING（带传入 tenantId/userId，ON CONFLICT DO NOTHING）后**读回既存行**（`dirQueryByLookup('email', canonicalizeEmail(email))`）；`reservedByUs = 读回行.operation_id === operationId`（**按 operationId 判，非比对传入 tenantId**——重试传新随机 tenantId 与既存不等是正常的）；`canonicalTenantId/canonicalUserId = 读回行.tenant_id/user_id`（首次即刚插的、重试即上次持久化的，调用方一律用 canonical 值写 shard/签 token，绝不用本次随机值）。`reservedByUs:false` 表示他人已占 email → 调用方转 `AUTH_EMAIL_EXISTS`。
  - `activateTenant({ email, operationId }): boolean` — CAS，rowsAffected===1。
  - `resolveByEmail(email): { tenantId; userId; status } | null` — 内部 canonicalizeEmail。
  - `resolveByRefreshTokenHash(hash): { tenantId } | null` — 只在 ACTIVE 命中时返 tenantId，否则 null。
  - `resolveByApiKeyHash(hash): { tenantId } | null` — 同上。
  - `recordActiveLookup({ tenantId, lookupKind, lookupValue }): void` — 建 ACTIVE 目录项（token/key 由已 ACTIVE 租户签发，无两段）；ON CONFLICT DO NOTHING 后**读回校验 tenant_id===tenantId**，不等则 throw（冲突不假定同映射，第 3 轮 Codex #5）；写异常向上抛（调用方据此不签发凭据）。
  - `reserveEmailChange({ tenantId, userId, newEmail }): { operationId }` — 新 email 建 PENDING（旧 email ACTIVE 项保留，不锁死）；新 email 冲突他人 → throw。`completeEmailChange({ tenantId, oldEmail, newEmail, operationId }): void` — CAS 新 email PENDING→ACTIVE + removeLookup 旧 email。`rollbackEmailChange({ newEmail, operationId }): void` — 删未竟的新 email PENDING（改名回滚，旧 email 仍权威）。（跨库改名状态机见 Task 9，非 coordinator 单事务——shard users.email 是另一库写。）
  - `removeLookup(lookupKind, lookupValue): void` — `dirCmdDeleteByLookup`（撤销时清，尽力而为；正确性靠 shard is_revoked 权威）。
  - `listPending(cutoff): Array<{ tenantId; userId; operationId; lookupKind; lookupValue }>` — `dirQueryPendingBefore`（恢复 worker 用，Task 8）。

- [ ] **Step 1: 门面单测（红）**

`FakeMultiShardResolver`（coordinator 独立 db）。断言：`reserveTenant` 写落 **coordinator db**（非 shard）；**首次 reserve 返 `reservedByUs:true` 且 canonicalTenantId/canonicalUserId===传入值**；**同 email 用不同随机 tenantId 重试 reserve → 仍 `reservedByUs:true` 且 canonicalTenantId===第一次的（非本次随机值）**（确定性 opId 重入的核心断言，Codex #1）；模拟他人先占（先用另一 operationId 手插 email 行）后本次 reserve → `reservedByUs:false`；`resolveByEmail` PENDING 时返 status=PENDING（含 userId）；activate 后 ACTIVE；`recordActiveLookup` 遇既存他租户映射 → throw；`reserveEmailChange`→新 email PENDING+旧仍 ACTIVE，`completeEmailChange`→新 ACTIVE+旧删，`rollbackEmailChange`→新 PENDING 删旧仍 ACTIVE。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 写 `TenantIdentityDirectory`** — 每方法 `this.resolver.coordinatorDb()` + Task 3 executor。`deriveOperationId` 用 `node:crypto` sha256。

- [ ] **Step 4: 跑测试确认通过** — Expected PASS。

- [ ] **Step 5: Commit**

```bash
git add src/identity/tenant-identity-directory.ts src/test/unit/tenant-identity-directory.test.ts
git commit -m "feat(shard): TenantIdentityDirectory 门面(确定性 opId reserve 幂等/CAS activate/resolve/record/remove)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: AuthService register 状态机 + login 经目录（含老用户兼容）

**Files:**
- Modify: `src/identity/auth-service.ts:57-136`（ctor + register + login；refresh 编译通过留 Task 7）
- Modify: `src/billing/stripe-client.ts:29`（`createCustomer` 加 idempotencyKey 形参）
- Modify: `src/server/routes/auth.ts:211-280`（透传 `Idempotency-Key` header 给 register）、`src/server/app.ts:753`（传 resolver）
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（新）+ `src/test/integration/auth-api.test.ts`（回归 + 老用户 login + **重复 register 不接管**）

**Interfaces:**
- Consumes: `TenantIdentityDirectory`（Task 4）、`TenantDbResolver`、`IdentityWriter`、`bootCmdMarkComplete`/`bootQueryByOperation`（Task 3）、`createCustomer`（Stripe，事务外）。
- Produces: `AuthService` ctor `(private readonly resolver, private readonly config, private readonly idGen = defaultIdGen)`；`private directory = new TenantIdentityDirectory(this.resolver)`。`register(email, password, opts?: { idempotencyKey?: string })`——route 从 `Idempotency-Key` header 取。register/login HTTP 契约不变（新 header 可选）。

- [ ] **Step 1: 状态机 + 安全 + 兼容行为测（红）**

`auth-mixed-scope-sharding.test.ts`（`FakeMultiShardResolver` 2 shard + 独立 coordinator）：
1. **register 落点**：register(email) → coordinator 有 email ACTIVE + 对应 shard 有 user 行 + `tenant_bootstrap` (tenant,op) COMPLETE + **其他 shard 无** user。
2. **⚠️账号接管回归（Codex 致命项，最重要）**：register(`victim@x`, pw1) 成功后，**再** register(`victim@x`, pw2, 无 idempotency-key 或不同 key) → **抛 `AUTH_EMAIL_EXISTS`(409)、绝不签 token、绝不返回 victim 的 userId**。断言无任何 token pair 产出。这是根治 round-3 漏洞的锚。
3. **CAS 前崩（shard 写成功、activate 未调）**：stub `activateTenant` 抛错 → shard 有 user+bootstrap COMPLETE，coordinator 留 **PENDING**，**未签发 token**。
4. **CAS 失败续做（重试同 idempotency-key）**：同 idempotency-key 重试、shard 已 COMPLETE、目录已被前次激活为 ACTIVE → activate 返 false 但 `reservedByUs:true` 且 resolveByEmail 是本 tenant ACTIVE → 正常签发（幂等收敛，非接管——因 key 私有属原客户端）。
5. **确定性重试 canonical 身份（带 idempotency-key）**：注确定性 idGen 首次 register(`e`, pw, key=`K`)→shard `tenant_A`/`u_A`+COMPLETE。**同 key=`K`** 但注不同 idGen(`tenant_B`) 重试 → reserve `reservedByUs:true`（同 opId=K）且 canonicalTenantId=`tenant_A` → 复用 `tenant_A`/`u_A` 签发（不重建不用 B）。**不同 key** 重试 → 走用例 2（409，不接管）。
6. **PENDING 他人占**：手插另一 opId 的 PENDING email → register(同 email, 无匹配 key) → `reservedByUs:false` 且 PENDING → 抛 `AUTH_REGISTRATION_IN_PROGRESS`、不签 token。
7. **login 经目录**：register 后 login(email) → `resolveByEmail` ACTIVE → `dbForTenant` 验密码成功；PENDING 项 login → 拒。
8. **老用户兼容（Task 2 回填后）**：手插「回填」ACTIVE 目录项（大小写混合 email 归一化）+ 对应 shard user → login(原大小写 email) 成功。
9. **Stripe 事务外幂等**：spy `createCustomer`；首次 register 调一次带 `idempotencyKey=operationId`（**在 shard 事务外调用**——可用 spy 记录调用时 tx 未开）；同 key 重试（shard COMPLETE）→ **不再调 Stripe**（读回既存 customerId）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（ctor 裸 tx）。

- [ ] **Step 3: 改 register/login + stripe-client**

先改 `stripe-client.ts`：`createCustomer(config, email, tenantId, idempotencyKey?: string)` → `stripe.customers.create({email, metadata:{tenantId}}, idempotencyKey ? { idempotencyKey } : undefined)`。

register 新序列（替换 `:65-102`）：
```
const canonEmail = canonicalizeEmail(email);
const existing = directory.resolveByEmail(canonEmail);
if (existing?.status === 'ACTIVE') throw AUTH_EMAIL_EXISTS;          // 已注册→409，绝不签 token（堵接管）
const operationId = opts?.idempotencyKey ?? ('reg:' + randomUUID()); // 私有幂等键；缺则一次性随机
const tenantId = this.idGen.tenantId();   // 候选；canonical 以 reserve 读回为准
const userId = this.idGen.userId();
const { reservedByUs, canonicalTenantId, canonicalUserId } =
  directory.reserveTenant({ tenantId, userId, operationId, email: canonEmail });
if (!reservedByUs) {
  const cur = directory.resolveByEmail(canonEmail);
  throw cur?.status === 'ACTIVE' ? AUTH_EMAIL_EXISTS : AUTH_REGISTRATION_IN_PROGRESS;  // 不签 token
}
const boot = resolver.dbForTenant(canonicalTenantId).queryOne(bootQueryByOperation(canonicalTenantId, operationId));
let customerId;
if (boot?.status !== 'COMPLETE') {
  customerId = await createCustomer(config, canonEmail, canonicalTenantId, operationId);  // 事务外，幂等键
  resolver.dbForTenant(canonicalTenantId).transaction(() => {        // 短同步事务
    建 user(canonicalUserId,email=canonEmail)/subscription(customerId)/quota/identity(new IdentityWriter(canonicalTenantId, tx));
    bootCmdMarkComplete({ tenantId: canonicalTenantId, operationId });
  });
} else {
  customerId = <从既存 subscription 读回>;   // 重试：跳过 Stripe 与重建
}
const activated = directory.activateTenant({ email: canonEmail, operationId });
if (!activated) {
  const row = directory.resolveByEmail(canonEmail);
  // reservedByUs 前置门已证 canonicalTenantId 属本次 opId（opId 私有不可伪造），故 tenantId+ACTIVE 两元即可
  if (!(row && row.tenantId === canonicalTenantId && row.status === 'ACTIVE'))
    throw AUTH_REGISTRATION_RETRY;
}
generateTokenPair(app, canonicalUserId, canonicalTenantId, role);   // 仅本次新注册的 canonical 身份，绝不发既存账号 token
```
login（替换 `:104-117`）：`const canon = canonicalizeEmail(email); const entry = directory.resolveByEmail(canon); if (!entry || entry.status !== 'ACTIVE') throw INVALID_CREDENTIALS; const tx = resolver.dbForTenant(entry.tenantId); const user = tx.queryOne(authQueryUserByEmail(canon)); <argon2 verify + generateTokenPair(app, user.id, user.tenant_id, user.role)>`。
refresh（`:119-136`）：本 Task 只保证 ctor 改造后编译 + 不破单库（暂用 user 表直查兜底），标注 `// Task 7: refresh_token_hash→tenant via directory`。

- [ ] **Step 4: 同步构造点 + id-generator seam + canonicalizeEmail + header 透传** — `AuthService` ctor 加可选 `idGen: { tenantId(): string; userId(): string } = { tenantId: () => 'tenant_'+randomUUID(), userId: () => randomUUID() }`；`register` 加 `opts?: { idempotencyKey?: string }`，`routes/auth.ts` register handler 从 `request.headers['idempotency-key']` 取传入；`registerAuthRoutes(app, resolver, config)` + `new AuthService(resolver, config)`（生产用默认 idGen）；`app.ts:753` 传 resolver。新建 `src/identity/email-canonical.ts` 导出 `canonicalizeEmail`。新错误码 `AUTH_REGISTRATION_RETRY` + `AUTH_REGISTRATION_IN_PROGRESS` 注册进错误常量表（照抄 `AUTH_EMAIL_EXISTS` 位置）。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/integration/auth-api.test.ts 2>&1 | tail -25`
Expected: 全绿。**auth-api 回归特别确认**：单库下 register 多写目录/bootstrap 后，email 重复仍返 `AUTH_EMAIL_EXISTS`（错误码路径不变、绝不签 token）；老用户 login（Step 1.8 集成层建一条）通。

- [ ] **Step 6: Commit**

```bash
git add src/identity/auth-service.ts src/identity/email-canonical.ts src/billing/stripe-client.ts src/server/routes/auth.ts src/server/app.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): AuthService register 状态机(绝不认证/私有幂等键防接管/canonical 身份重入/per-op bootstrap/Stripe 事务外幂等/email 归一化)+login 经目录+老用户兼容

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: SSO/OIDC + SCIM createUser 经目录定位

**Files:**
- Modify: `src/identity/sso-user-service.ts:28-95`、`src/server/routes/auth-sso.ts:95`、`src/server/routes/auth-oidc.ts:79`
- Modify: `src/enterprise/scim-provisioning-service.ts:70-142`、`src/server/app-services.ts:93`
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（追加）+ `stripe-auth-sso.test.ts`/`scim-compliance-evidence.test.ts` 回归

**Interfaces:**
- Consumes: `TenantIdentityDirectory`、`TenantDbResolver`、`IdentityWriter`、`bootQueryByOperation`、`canonicalizeEmail`。
- Produces: `SsoUserService` ctor `(resolver, idGen?)`（同 Task 5 id-generator seam 默认 randomUUID，测试注确定性 id）；`ScimProvisioningService` ctor `(resolver, evidenceRecorder?, evidenceFailureSink?)`。签名/返回不变。email 全部经 `canonicalizeEmail`。

- [ ] **Step 1: SSO/SCIM 行为测（红）**

- `findOrCreateForSso`（自生成 tenant）：走 Task 5 同款 reservation 序列（reserve 读回 canonical 身份→shard 单事务写+bootstrap(operationId)→CAS）；注确定性 idGen 断言重试复用 canonical 身份。
- `findOrCreateForOidc(email, expectedTenantId)`：目录 email 已属**其他** tenant → 抛 `AUTH_SSO_FAILED`（从 coordinator 目录判定，非某 shard users 查）；一致则 `dbForTenant(expectedTenantId)` 建/取。
- SCIM `createUser(tenantId, {email})`：目录 email 属其他 tenant → 抛「已存在于其他 tenant」；新 email → reserve(email→tenantId)→`dbForTenant(tenantId)` 单事务写 user+identity+bootstrap（若该 tenant 首次）→ activate。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 改 SSO/SCIM**

- `sso-user-service.ts`：ctor `(resolver, idGen?)` + `directory`；`identityWriter(tenantId)` → `new IdentityWriter(tenantId, this.resolver.dbForTenant(tenantId))`；`:47` 全局 email 查 → `directory.resolveByEmail(canonicalizeEmail(email))`；`:50` 一致性对 `entry.tenantId`；`findOrCreateForSso` 自生成走 reservation（canonical 身份+per-op bootstrap）。
- `scim-provisioning-service.ts`：ctor `(resolver, ...)`；`:117` 全局 email 查 → `directory.resolveByEmail(canonicalizeEmail(email))`；写走 `dbForTenant(tenantId)` 单事务 + `bootCmdMarkComplete(tenantId, operationId)`（本次 createUser 的独立 operationId，per-op 粒度）。
- 同步 `auth-sso.ts:95`/`auth-oidc.ts:79`/`app-services.ts:93` 传 resolver。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/unit/stripe-auth-sso.test.ts src/test/integration/scim-compliance-evidence.test.ts 2>&1 | tail -20`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/identity/sso-user-service.ts src/server/routes/auth-sso.ts src/server/routes/auth-oidc.ts src/enterprise/scim-provisioning-service.ts src/server/app-services.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): SSO/OIDC+SCIM createUser 经 coordinator 目录定位 email→tenant(自生成走 reservation)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: refresh_token + api_key hash→tenant 目录反查（目录=定位器，shard=权威）

**Files:**
- Modify: `src/identity/auth-service.ts`（refresh 完整定位 + 签发/轮转 token 时 `recordActiveLookup`；revoke/logout `removeLookup`）
- Modify: `src/server/plugins/auth.ts:52-160`、`src/server/app.ts:242`
- Modify: `src/billing/api-key-service.ts`（create 时 `recordActiveLookup`；**revoke 补按 hash 撤销能力** → `removeLookup`）
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（追加）+ api-key 回归

**Interfaces:**
- Consumes: `TenantIdentityDirectory.recordActiveLookup/resolveByRefreshTokenHash/resolveByApiKeyHash/removeLookup`。
- Produces: `registerAuth(app, config, resolver)`；`ApiKeyService.revoke` 现签名（`id`+`tenantId`）执行时**顺带**取该 key 的 hash 调 `removeLookup`（若无法从 id 取回 hash，则新增 `revokeByHash(keyHash)` 或在 revoke 内先查 hash——见 Step 3 定死）。

- [ ] **Step 1: refresh/api-key 行为测（红）**

- refresh：签发时目录有 token_hash→tenant ACTIVE → refresh 经 `resolveByRefreshTokenHash` 得 tenantId → `dbForTenant` 查 token **且校验 shard 内 is_revoked=0**（shard 权威）→ 发新。跨 shard：token 属 s1，从 coordinator 反查得 s1 不误查 s0。
- **目录=定位器权威在 shard**：手动把目录项留着但 shard 内 `is_revoked=1` → refresh **拒**（证明 shard 权威，目录多余项不导致越权）。
- api-key：create → 目录 ACTIVE → preHandler `resolveByApiKeyHash` → `dbForTenant` 验 `is_revoked=0`（shard 权威）。
- revoke：revoke(id) → shard `is_revoked=1` **且** `removeLookup` 清目录项 → 后续 preHandler resolve 返 null（或 resolve 命中但 shard 拒，二者都安全）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 改 refresh/api-key**

- `auth-service.ts` refresh：`const entry = directory.resolveByRefreshTokenHash(tokenHash); if (!entry) throw INVALID; const tx = resolver.dbForTenant(entry.tenantId); const row = tx.queryOne(authQueryRefreshToken(tokenHash)); if (!row || row.is_revoked) throw INVALID;`（shard 权威）。签发/轮转：新 token `recordActiveLookup`（token_hash），轮转旧 token shard 标 revoked + `removeLookup(旧 hash)`（非原子可接受：旧 token shard 已 revoked=权威拒，目录清晚了不越权）。logout 同。
- `server/plugins/auth.ts`：`registerAuth(app, config, resolver)`；`:144` `const entry = new TenantIdentityDirectory(resolver).resolveByApiKeyHash(keyHash); const tx = entry ? resolver.dbForTenant(entry.tenantId) : resolver.coordinatorDb()/*单库回退*/; const row = tx.queryOne(apikeyQueryByHash(keyHash)); if (!row || row.is_revoked) <认证失败静默回退>;` 保留 `:160` catch。
- `api-key-service.ts`：create 后 `directory.recordActiveLookup({tenantId, lookupKind:'api_key_hash', lookupValue:keyHash})`；**revoke 定死**：revoke(id, tenantId) 先 `dbForTenant(tenantId).queryOne(apikeyQueryById(id))` 取 keyHash → shard 标 revoked → `directory.removeLookup('api_key_hash', keyHash)`。若无 `apikeyQueryById` 工厂则新增（照抄 apikeyQueryByHash）。
- 同步 `app.ts:242`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/unit/appservices-tenant-scoped-sharding.test.ts 2>&1 | tail -20`
Expected: 全绿（含 Plan 1b ApiKey 管理方法回归）。

- [ ] **Step 5: Commit**

```bash
git add src/identity/auth-service.ts src/server/plugins/auth.ts src/server/app.ts src/billing/api-key-service.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): refresh+api_key hash→tenant 经目录定位(目录=定位器/shard is_revoked=权威)+revoke 清目录

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: PENDING 恢复 worker（凭 bootstrap COMPLETE 补 ACTIVE，绝不取消）

**Files:**
- Create: `src/identity/tenant-reservation-recovery.ts`
- Modify: `src/server/app.ts`（装配 worker，经 resolver）
- Modify: `src/identity/tenant-identity-directory.ts`（加 `listPending(cutoff)`）
- Test: `src/test/unit/tenant-reservation-recovery.test.ts`

**Interfaces:**
- Consumes: `TenantIdentityDirectory.listPending/activateTenant`、`TenantDbResolver`、`bootQueryByTenant`（Task 3）。
- Produces: `TenantReservationRecovery`，`reconcile(now): { activated; retained }` —— 扫 PENDING：`dbForTenant(tenantId)` 查 `tenant_bootstrap` **status=COMPLETE**（非「user 行存在」——半初始化也可能有 user 行，Codex #3）→ 是则 CAS 补 ACTIVE（activated++）；否则保留 PENDING + `logger.warn`（retained++），**绝不删/取消**。

- [ ] **Step 1: 恢复 worker 测（红）**

`FakeMultiShardResolver`。造两 PENDING（各带自己的 operationId）：A 的 shard 有**匹配 operationId 的** `tenant_bootstrap` COMPLETE（模拟 shard 写成功 CAS 丢）；B 的 shard **无匹配 operationId 的** bootstrap 行。`reconcile()` → A→ACTIVE（activated=1）；B **仍 PENDING**（retained=1，未删）。断言 B 目录项 reconcile 后仍在（`resolveByEmail` 返 PENDING 非 null）——spec §4.1.6 防孤儿核心。再断言两个 per-op 关键锚：① B 即使有 user 行但无匹配 bootstrap → 仍 retained（不误激活半初始化，Codex #3）；② **B 的 tenant 恰好有一条属于别的 operationId 的旧 COMPLETE（模拟 SCIM/OIDC 复用已存在 tenant）→ 仍 retained**（按 operationId 匹配，旧 COMPLETE 不误证本次 reservation，Codex 第 3 轮 #3）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 写 `TenantReservationRecovery` + `listPending`**

```
reconcile(now):
  for pending of directory.listPending(now - GRACE):   // 仅 lookup_kind='email' 的 PENDING
    const boot = resolver.dbForTenant(pending.tenantId).queryOne(
      bootQueryByOperation(pending.tenantId, pending.operationId));   // 按 operationId 匹配（per-op）
    if (boot?.status === 'COMPLETE') { directory.activateTenant({ email: pending.lookupValue, operationId: pending.operationId }); activated++; }
    else { logger.warn('reservation retained: no COMPLETE for this operation', { tenantId: pending.tenantId, operationId: pending.operationId }); retained++; }  // 绝不取消
```
`listPending` 用 `dirQueryPendingBefore`（Task 3）过滤 `lookup_kind='email'`（只 register/SSO reservation 需恢复；token/key 是直接 ACTIVE 无 PENDING）。

- [ ] **Step 4: 跑测试确认通过** — Expected PASS。

- [ ] **Step 5: 装配 worker（app.ts）** — 照抄现有 timer worker 装配（如 SettlementReconciliationWorker），经 resolver。**代码里根本不写取消分支**（Phase 0 铁律）。

- [ ] **Step 6: Commit**

```bash
git add src/identity/tenant-reservation-recovery.ts src/identity/tenant-identity-directory.ts src/server/app.ts src/test/unit/tenant-reservation-recovery.test.ts
git commit -m "feat(shard): PENDING 恢复 worker(凭 bootstrap COMPLETE 补 ACTIVE，未完成保留+告警绝不取消)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 过渡服务收口 + inventory 校准 + 全门验收

**Files:**
- Modify: `src/identity/user-email-directory-service.ts`（updateEmail 唯一性经 `TenantIdentityDirectory` + 改 email 同步目录项）
- Modify: `src/enterprise/scim-tenant-directory.ts`（token→tenant 语义标注/归并）
- Modify: `src/storage/db-access-inventory.ts`（mixed-scope edge 逐条 planned→verified）
- Test: `src/test/unit/db-access-inventory-completeness.test.ts` + `npm run check:db-access` + `npm run test:golden`

**Interfaces:**
- Consumes: `TenantIdentityDirectory`。

- [ ] **Step 1: updateEmail 跨库可恢复状态机（Codex 第 3 轮 #C，红→绿）**

changeEmail 是**跨库**写（coordinator 目录 + shard users.email），非原子。用可恢复小状态机避免「目录改了 shard 没改→login 永久失败」：
```
1. 唯一性：directory.resolveByEmail(canon(newEmail)) 非 null 且 tenantId≠自己 → 拒。
2. coordinator: reserveEmailChange —— 新 email 建 PENDING 目录项（operationId=change 专属），旧 email ACTIVE 项**保留不删**（旧 email 仍可 login，不锁死）。
3. shard 事务: UPDATE users SET email=canon(newEmail) WHERE tenant_id=? AND id=?。
4. coordinator: activate 新 email PENDING→ACTIVE + removeLookup 旧 email（此后新 email 权威，旧失效）。
5. 崩溃恢复：changeEmail 恢复分支（并入 Task 8 恢复 worker 或 updateEmail 幂等重试）——若 shard 已是 newEmail 则补 activate 新+删旧；若 shard 仍 oldEmail 则保留旧 ACTIVE + 删新 PENDING（回滚未竟改名，用户仍用旧 email 登录）。
```
在 `TenantIdentityDirectory` 加 `reserveEmailChange`/`completeEmailChange`/`rollbackEmailChange`。测：改 email 成功后新 email login 通、旧 email 拒；**步骤 3 后步骤 4 前崩溃 → 新旧 email 都不锁死**（旧仍 ACTIVE 可 login，恢复后收敛到新）；跨库窗口任一点崩溃无「两 email 都登不上」。per-tenant + 跨库唯一性测。

- [ ] **Step 2: inventory 逐 edge 校准**

`db-access-inventory.ts`：Auth/SSO/SCIM/registerAuth/updateEmail 的 mixed-scope edge——**真经 directory + dbForTenant + 有 auth-mixed-scope-sharding.test.ts 2-shard 覆盖**才 planned→verified（逐 edge，绝不 mass-upgrade，对齐 Plan 1b 铁律 + 现有 `db-access-inventory-completeness.test.ts` 双门）。`TenantIdentityDirectory`/`TenantReservationRecovery` 门面 edge 登记 coordinator 定位 disposition。重算每组 `expectedCount === coveredEdgeIds.length`（记忆 fingerprint 校验）。仍携带 root-db/未测能力的保持 planned。

- [ ] **Step 3: 全门验收**

Run: `npm run typecheck 2>&1 | tail -5`
Run: `npm run check:db-access 2>&1 | tail -15`（五诊断全空；mixed-scope verified/planned 准确）
Run: `rg -n 'new AuthService\(|new SsoUserService\(|new ScimProvisioningService\(|registerAuth\(' src | rg -v 'resolver'`（无裸 db/tx 残留，命中仅注释）
Expected: check:db-access 绿；rg 无裸构造。

- [ ] **Step 4: test:golden 全门**

Run: `npm run test:golden 2>&1 | tail -30`
Expected: **EXIT 0**，无 `fail N>0`，链走到最后一个门（db-access）。逐个确认 unit/integration/contract/packages/ga:check 绿（记忆 [[merge-gate-must-run-test-golden]]：不能只跑子集）。

- [ ] **Step 5: Commit**

```bash
git add src/identity/user-email-directory-service.ts src/enterprise/scim-tenant-directory.ts src/identity/tenant-identity-directory.ts src/storage/db-access-inventory.ts src/test/unit/db-access-inventory-completeness.test.ts
git commit -m "feat(shard): Plan 1c 收口——过渡目录服务经真目录表+inventory mixed-scope edge 校准 verified

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（写完计划后自检）

- **Spec 覆盖**：§4.1 coordinator directory ✅（Task 1/3/4）；PENDING→ACTIVE reservation ✅（Task 5）；只认 ACTIVE ✅（Task 5/6/7）；email 唯一挡并发 ✅（Task 1 UNIQUE + Task 5.1.4）；register 每步崩溃收敛 ✅（Task 5.1.2-5 + Task 8 bootstrap 判据）；PENDING 不自动取消 ✅（Task 8）；token/key 反查（用户选的范围）✅（Task 7）。
- **Codex 8 项**：① operationId 确定性 sha256 派生 + reserve ON CONFLICT 幂等 + shard 携 operationId（bootstrap 标记）✅（Task 3/4/5）；② 老用户回填迁移 ✅（Task 2，硬前置）；③ shard 单事务 + bootstrap COMPLETE 标记、恢复凭标记非行存在 ✅（Task 3/5/8）；④ CAS 失败不发 token ✅（Task 5.1.3）；⑤ 目录=定位器/shard 权威、双写非原子可接受 ✅（Architecture + Task 7）；⑥ revoke by hash（revoke 先查 hash 再清目录）✅（Task 7）；⑦ 目录不存 shardId、用 `shardIdForTenant` 纯函数、fake 无需 shardIdForTenant 方法 ✅（Architecture）；⑧ 6 迁移同步点全显式 + 同 commit 补 ✅（Global Constraints + Task 1/2）。
- **Codex 第 3 轮 5 项 + 2 新问题**：① canonical identity（reserve 返 canonicalTenantId/UserId、reservedByUs 按 operationId、reservation 存 user_id、重试复用不重生）✅（Task 3/4/5.1.5）；② per-op bootstrap（PK `(tenant_id,operation_id)`、`bootQueryByOperation`、worker 按 opId 匹配）✅（Task 2/3/8）；③ email canonicalization 单一函数贯穿 + 回填归一化 users.email + 冲突 fail-closed ✅（Task 2/5，`email-canonical.ts`）；④ Stripe operationId 幂等键 + customerId 持久化/读回 ✅（Task 5.3/5.1.8）；⑤ directory 写失败可用性（recordActiveLookup 读回校验、写失败不发凭据）✅（Task 4/7）；⑥ id-generator seam 修 fake（AuthService/SsoUserService 注 idGen，测试预登记）✅（Architecture + Task 5.4/6）；⑦ 迁移同步点精确化（legacy fixture 两数组显式、删不存在的期望数组/range 声明）✅（Global Constraints + Task 1/2）。CAS 三元匹配（tenantId+opId+ACTIVE）✅（Task 5.3）。
- **Codex 第 4 轮 3 阻断**：① register 账号接管根治——register 绝不认证：ACTIVE→409 绝不签 token、opId 来自客户端私有 Idempotency-Key（非 email 派生，他人不可伪造）、PENDING 他人占→IN_PROGRESS 不签 token ✅（Architecture + Task 5.1.2 接管回归锚 + 5.3 序列）；② Stripe 事务外——`createCustomer` 加 idempotencyKey 形参、HTTP 在短同步 shard 事务**外**先做、DB 失败同 key 复用 customer ✅（Architecture + Task 5 Files/Step3/5.1.9，改 `stripe-client.ts`）；③ changeEmail 跨库可恢复状态机——reserve 新 PENDING(旧不删)→shard 改→complete 激活新删旧→崩溃保留旧 ACTIVE 不锁死+恢复收敛 ✅（Task 4 trio + Task 9.1）。email UPDATE 显式规范化语义（迁移标明成 canonical login 标识、展示格式另设 display_email）✅（Task 2）。CAS 两元（tenantId+ACTIVE，opId 由 reservedByUs 前置门保证）✅（Task 5.3 注释统一）。
- **Placeholder 扫描**：DSL builder API 标「以 v078/v108 为准」（防自创非 placeholder）；legacy fixture「照末条 raw 风格加对应版本」是确定动作非 TBD。
- **类型一致**：`reserveTenant` 返 `{operationId?, reservedByUs, canonicalTenantId, canonicalUserId}`（operationId 由调用方传入/派生）、`activateTenant` 返 boolean、`resolveByEmail` 返 `{tenantId, userId, status}|null`、`resolveBy*Hash` 返 `{tenantId}|null`、`recordActiveLookup`/`removeLookup`/`reserveEmailChange`/`completeEmailChange`/`rollbackEmailChange`/`listPending` 全 Task 引用一致；`dirCmdReserve` 带 userId+operationId 入参、`bootCmdMarkComplete`/`bootQueryByOperation`（per-op）一致；`idGen: {tenantId();userId()}` seam 一致；`register(email, password, opts?:{idempotencyKey?})`；`createCustomer(config,email,tenantId,idempotencyKey?)`；`canonicalizeEmail` 单一真源；错误码 `AUTH_REGISTRATION_RETRY` + `AUTH_REGISTRATION_IN_PROGRESS` 在 Task 5 注册。
- **复杂度**：目录门面方法均单一职责、≤3 层缩进；三类 lookup 合表靠 `lookup_kind` 判别（非三表）；bootstrap per-op 表两列主键。register 序列虽长但线性（reserve→shard 单事务→CAS→签发），无深嵌套。恢复 worker reconcile 单循环。
- **向后兼容/破坏性**：回填迁移（含 email 归一化）保证零中断——Codex 致命项闭合；单库 coordinatorDb≡dbForTenant 等价现状；错误码路径（AUTH_EMAIL_EXISTS）保持；idGen 默认 randomUUID 生产行为不变。
