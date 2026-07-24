# 租户分片 Phase 0 · Plan 1c（Auth mixed-scope + coordinator identity directory）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐 task 实现。步骤用 checkbox（`- [ ]`）跟踪。
>
> **第 2 轮修订**：采纳 Codex 独立复审 57/100 退回的 8 项确认缺陷——① operationId 确定性重入（非随机）② 老用户 login 致命兼容→回填迁移 ③ shard 原子完成标记(bootstrap ledger) ④ CAS 失败不签发 token ⑤ 目录=定位器、shard is_revoked=权威（消双写一致性依赖）⑥ revoke-by-hash 接口 ⑦ 目录不存 shardId（tenantId 纯函数派生，消 `shardIdForTenant()` 幽灵方法 + 修 fake）⑧ 6 迁移同步点全显式。
>
> **第 3 轮修订**：采纳 Codex 复审 69/100 退回的 5 项——① **canonical identity**：`reserveTenant` 返回读回行的 canonical `(tenantId, userId)`，`reservedByUs` 按 operationId 匹配（非按本次随机 tenantId 比对）；reservation 表存 userId；重试用 canonical 身份不重生。② **bootstrap ledger 粒度**：主键 `(tenant_id, operation_id)`（非 tenant_id），恢复 worker 按 operationId 匹配——SCIM/OIDC 向已有 COMPLETE tenant 加用户时不误激活本次新 reservation。③ **email canonicalization**：单一 `canonicalizeEmail`（lowercase+trim）贯穿目录 lookup_value / users.email 写入 / 回填 SQL / login 派生——回填迁移也归一化历史 email（否则大小写不匹配锁死老用户）。④ **Stripe 幂等**：`stripe.customers.create` 用 operationId 作 idempotency key + customerId 持久化+重入读回；Stripe 成功 shard 事务失败时恢复不重复建。⑤ **directory 写失败可用性**：`recordActiveLookup` ON CONFLICT 后读回校验 tenantId（非假定冲突即同映射）；目录写失败时不返回凭据。⑥ **id-generator seam 修 fake**：AuthService/SsoUserService 注入 `idGenerator`（默认 randomUUID），测试注确定性 id 并预登记进 fake——真 register 测试可跑。⑦ 迁移同步点精确化：实际是 migration 文件 / index 三子处 / VERSION_MAP / `LEGACY_SQLITE_MIGRATIONS` / `LEGACY_POSTGRES_MIGRATIONS` / dist（parity 无独立硬编码期望数组/range 断言——删除不存在的同步点声明），且 `git add` 须含 legacy fixture 文件。

**Goal:** 把「无 tenantId 的全局定位 + 租户级写」这类 mixed-scope 入口（register/login/SSO/SCIM/refresh/api-key）切到 coordinator identity directory 定位后再到正确 shard 读写，落地 spec §4.1 的 `PENDING → ACTIVE` reservation 状态机（唯一真跨库写序列），**且升级前的历史用户无缝可用**。

**Architecture:** coordinator 上建 `tenant_identity_directory`（`lookup_kind ∈ {email,refresh_token_hash,api_key_hash}` × `lookup_value` → `tenant_id` 全局反查 + `PENDING/ACTIVE`）。

关键设计决策（回应 Codex）：
- **目录=定位器，权威在 shard**：目录项只回答「这个 email/token/key 属哪个 tenant」；账号是否有效（密码、is_revoked、过期）永远以 `dbForTenant(tenantId)` 的 shard 内行为权威真源。故目录与 shard 的「双写」不需要原子/2PC——目录项过期/多余只导致「定位到一个 shard 后在 shard 上验证失败」（安全的拒绝），绝不导致越权。撤销以 shard `is_revoked` 为准，目录项清理是尽力而为的垃圾回收（清晚了不影响正确性，因 shard 已拒）。
- **目录不存 shardId**：shardId 是 `tenantId` 的纯函数（`shardIdForTenant(tenantId, shardIds)`，`shard-hash.ts`，`dbForTenant` 内部即用它）。存 shardId 是会漂移的冗余，故目录只存 `tenant_id`，路由永远靠 `resolver.dbForTenant(tenantId)`。**无需给 resolver 加 `shardIdForTenant()` 方法**。
- **确定性 operationId + canonical identity（第 3 轮修订）**：`operationId = 'reg:' + sha256(canonicalizeEmail(email))`。reserve 是**先写后读回**：`INSERT INTO tenant_identity_directory (tenant_id, user_id, operation_id, ...) ON CONFLICT(lookup_kind,lookup_value) DO NOTHING` 后立刻 `dirQueryByLookup` 读回既存行，返回**读回行的 canonical `(tenantId, userId)`**（首次即本次随机生成的、重试即上次持久化的），`reservedByUs = 读回行.operation_id === 本次 operationId`（按 operationId 匹配，**不比对本次随机 tenantId**——重试新随机 tenantId 与既存不等是正常的，不能据此判 false）。故 reservation 表**存 user_id**，重试用 canonical `(tenantId,userId)` 写 shard、签发 token，绝不重生身份。同 email 的独立请求 operationId 相同（email-first-writer-wins：第一个建 reservation 的赢，后来者读回 operationId≠自己 → `reservedByUs:false` → `AUTH_EMAIL_EXISTS`）。
- **shard bootstrap 完成标记（第 3 轮：per-operation 粒度）**：register 在 `dbForTenant(tenantId)` 的**单个事务**内写 user/subscription/quota/identity **加一行 `tenant_bootstrap(tenant_id, operation_id, status='COMPLETE')`，主键 `(tenant_id, operation_id)`**。CAS activate 与恢复 worker 以**匹配 operationId 的 COMPLETE 行**为判据（非「user 行存在」也非「tenant 有任一 COMPLETE」——SCIM/OIDC 向已 COMPLETE 的 tenant 加用户时，本次新 reservation 有独立 operationId，旧 COMPLETE 不能误证本次完成）。
- **CAS 失败不签发 token**：`activateTenant` 返 false 后读回目录行——仅当 `tenantId===canonicalTenantId && operationId===本次 && status==='ACTIVE'`（本次 reservation 确已激活）才签发；否则抛 `AUTH_REGISTRATION_RETRY`（只查 status===ACTIVE 太宽松，必须三元匹配）。
- **email canonicalization（第 3 轮）**：单一纯函数 `canonicalizeEmail(email) = email.trim().toLowerCase()`（`src/identity/email-canonical.ts` 新建）贯穿：目录 `lookup_value`、users.email 写入、**回填迁移的历史 email**、login/register/SSO/SCIM 的 email 派生——全部先 canonicalize。回填 SQL 对历史 `users.email` 也 `LOWER(TRIM(...))` 后写入目录，且**同步把 users.email 归一化**（迁移内 UPDATE），否则 login 派生的 canonical 值与 shard 内原值大小写不符→查不到。
- **Stripe 幂等（第 3 轮）**：register 的 `stripe.customers.create(...)` 传 `{ idempotencyKey: operationId }`（stripe-client 已支持 idempotencyKey 形参）+ 把返回 customerId 持久化在 subscription 行；重试时若 bootstrap 已 COMPLETE 则读回既存 customerId 不重复调 Stripe。Stripe 成功但 shard 事务失败→下次重试同 idempotencyKey 复用同 customer（不重复建）。
- **directory 写失败可用性（第 3 轮）**：`recordActiveLookup`（token/key）ON CONFLICT 后**读回校验 tenantId 属己**（冲突不假定同映射）；目录写失败（异常）时**不返回凭据**（token/key 签发前先确保目录 locator 写成功），避免「发了凭据但定位不到」。

register/SSO 自生成 tenantId 序列：`reserve（确定性 opId，读回 canonical (tenantId,userId)）→ 若 reservedByUs 且 shard 未 COMPLETE 则 dbForTenant 单事务写租户数据+Stripe(幂等)+bootstrap(tenant_id,operation_id) COMPLETE → CAS PENDING→ACTIVE → 仅本次 reservation 三元匹配 ACTIVE 才签发 token`。login/refresh/SSO/OIDC/SCIM/api-key 只认 `ACTIVE` 目录项定位 tenant，再到 shard 权威验证。恢复 worker 凭匹配 operationId 的 bootstrap COMPLETE 补 ACTIVE、绝不取消 PENDING。**新增回填迁移**把升级前 users/api_keys/refresh_tokens 写成 ACTIVE 目录项（email 归一化），老用户无缝。单库下 `coordinatorDb() ≡ dbForTenant`，行为等价现状。

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
  - `changeEmailLookup({ tenantId, userId, oldEmail, newEmail }): void` — coordinator 单事务内 `removeLookup('email', canon(oldEmail))` + reserve/record `(email, canon(newEmail))` ACTIVE，新 email 冲突他人则 throw。
  - `removeLookup(lookupKind, lookupValue): void` — `dirCmdDeleteByLookup`（撤销时清，尽力而为；正确性靠 shard is_revoked 权威）。
  - `listPending(cutoff): Array<{ tenantId; userId; operationId; lookupKind; lookupValue }>` — `dirQueryPendingBefore`（恢复 worker 用，Task 8）。

- [ ] **Step 1: 门面单测（红）**

`FakeMultiShardResolver`（coordinator 独立 db）。断言：`reserveTenant` 写落 **coordinator db**（非 shard）；**首次 reserve 返 `reservedByUs:true` 且 canonicalTenantId/canonicalUserId===传入值**；**同 email 用不同随机 tenantId 重试 reserve → 仍 `reservedByUs:true` 且 canonicalTenantId===第一次的（非本次随机值）**（确定性 opId 重入的核心断言，Codex #1）；模拟他人先占（先用另一 operationId 手插 email 行）后本次 reserve → `reservedByUs:false`；`resolveByEmail` PENDING 时返 status=PENDING（含 userId）；activate 后 ACTIVE；`recordActiveLookup` 遇既存他租户映射 → throw；`changeEmailLookup` 后旧 email 查 null、新 email 查命中。

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
- Modify: `src/server/routes/auth.ts:211-280`、`src/server/app.ts:753`（传 resolver）
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（新）+ `src/test/integration/auth-api.test.ts`（回归 + 老用户 login）

**Interfaces:**
- Consumes: `TenantIdentityDirectory`（Task 4）、`TenantDbResolver`、`IdentityWriter`、`bootCmdMarkComplete`（Task 3）。
- Produces: `AuthService` ctor `(private readonly resolver: TenantDbResolver, private readonly config: AppConfig)`；`private directory = new TenantIdentityDirectory(this.resolver)`。register/login HTTP 契约不变。

- [ ] **Step 1: 状态机 + 兼容行为测（红）**

`auth-mixed-scope-sharding.test.ts`（`FakeMultiShardResolver` 2 shard + 独立 coordinator）：
1. **register 落点**：register(email) → coordinator 有 email ACTIVE + 对应 shard（`dbForTenant(tenantId)`）有 user 行 + `tenant_bootstrap` COMPLETE + **其他 shard 无** user。
2. **CAS 前崩（shard 写成功、activate 未调）**：把 `directory.activateTenant` stub 成抛错 → 断言 shard 有 user + bootstrap COMPLETE，coordinator 留 **PENDING**，**且未签发 token**（register 抛错，无 token 返回）。
3. **CAS 失败不发 token（三元匹配）**：stub activate 返 false 且目录行非本次 reservation 的 ACTIVE → 断言抛 `AUTH_REGISTRATION_RETRY`、不签发 token；反之 stub activate 返 false 但目录已是本次 (tenantId,operationId) 的 ACTIVE（他调用已激活同 reservation）→ 断言正常签发。
4. **并发/重复 register 同 email**：先用另一 operationId 手插 email reservation（模拟他人先占）→ register(同 email, 新随机 tenantId) → `reservedByUs:false` → 抛 `AUTH_EMAIL_EXISTS`，不写第二 shard、不生第二 tenantId。
5. **确定性重试幂等 + canonical 身份**：注入确定性 idGenerator（首次 tenantId=`tenant_A`/userId=`u_A`）register→shard 有 `tenant_A`/`u_A` + COMPLETE。再注入**不同** idGenerator（`tenant_B`/`u_B`）模拟重试同 email → reserve 返 `reservedByUs:true` 且 **canonicalTenantId=`tenant_A`**（非 B）→ 因 shard `tenant_A` 已 COMPLETE 跳过重建、直接 activate 收敛、签发 token 用 `u_A`（**不重建、不用 B**）。这是 Codex #1 canonical 身份重入的核心锚。
6. **login 经目录**：register 后 login(email) → `resolveByEmail` ACTIVE → `dbForTenant` 验密码成功；PENDING 项 login → 拒。
7. **老用户兼容（Task 2 回填后）**：手插一个「回填」ACTIVE 目录项（大小写混合 email 归一化后）+ 对应 shard 的 user（归一化 email）**不经 register** → login(原大小写 email) 成功（证 canonical 一致）。Codex 致命兼容项的回归锚。
8. **Stripe 幂等**：spy Stripe createCustomer；首次 register 调一次带 idempotencyKey=operationId；重试同 email（shard 已 COMPLETE）→ **不再调 Stripe**（读回既存 customerId）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（ctor 裸 tx）。

- [ ] **Step 3: 改 register/login**

register 新序列（替换 `:65-102`）：
```
const canonEmail = canonicalizeEmail(email);
const tenantId = this.idGen.tenantId();  // 首次随机；仅作 reserve 的候选，canonical 以读回为准
const userId = this.idGen.userId();
const { operationId, reservedByUs, canonicalTenantId, canonicalUserId } =
  directory.reserveTenant({ tenantId, userId, email: canonEmail });
if (!reservedByUs) throw AUTH_EMAIL_EXISTS;   // 他人已占 canonEmail
const tx = resolver.dbForTenant(canonicalTenantId);  // 一律用 canonical（重试复用既存身份）
const boot = tx.queryOne(bootQueryByOperation(canonicalTenantId, operationId));
if (boot?.status !== 'COMPLETE') {
  tx.transaction(() => {
    const customerId = maybeCreateStripeCustomer({ idempotencyKey: operationId });  // 幂等；持久化进 subscription
    建 user(canonicalUserId,email=canonEmail)/subscription(customerId)/quota/identity(new IdentityWriter(canonicalTenantId, tx));
    bootCmdMarkComplete({ tenantId: canonicalTenantId, operationId });
  });
} // COMPLETE 已存在=重试，跳过重建；customerId 从既存 subscription 读回
const activated = directory.activateTenant({ email: canonEmail, operationId });
if (!activated) {
  const row = directory.resolveByEmail(canonEmail);
  if (!(row && row.tenantId === canonicalTenantId && row.status === 'ACTIVE'))  // 三元匹配（Codex #4）
    throw AUTH_REGISTRATION_RETRY;
}
generateTokenPair(app, canonicalUserId, canonicalTenantId, role);
```
login（替换 `:104-117`）：`const canon = canonicalizeEmail(email); const entry = directory.resolveByEmail(canon); if (!entry || entry.status !== 'ACTIVE') throw INVALID_CREDENTIALS; const tx = resolver.dbForTenant(entry.tenantId); const user = tx.queryOne(authQueryUserByEmail(canon)); <argon2 verify + generateTokenPair(app, user.id, user.tenant_id, user.role)>`。
refresh（`:119-136`）：本 Task 只保证 ctor 改造后编译 + 不破单库（暂用 user 表直查兜底），标注 `// Task 7: refresh_token_hash→tenant via directory`。

- [ ] **Step 4: 同步构造点 + id-generator seam + canonicalizeEmail** — `AuthService` ctor 加可选 `idGen: { tenantId(): string; userId(): string } = { tenantId: () => 'tenant_'+randomUUID(), userId: () => randomUUID() }`；`routes/auth.ts` `registerAuthRoutes(app, resolver, config)` + `new AuthService(resolver, config)`（生产用默认 idGen）；`app.ts:753` 传 resolver。新建 `src/identity/email-canonical.ts` 导出 `canonicalizeEmail`。新错误码 `AUTH_REGISTRATION_RETRY` 注册进错误常量表（照抄 `AUTH_EMAIL_EXISTS` 位置）。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/integration/auth-api.test.ts 2>&1 | tail -25`
Expected: 全绿。**auth-api 回归特别确认**：单库下 register 多写目录/bootstrap 后，email 重复仍返 `AUTH_EMAIL_EXISTS`（错误码路径不变）；老用户 login（Step 1.7 若在集成层也建一条）通。

- [ ] **Step 6: Commit**

```bash
git add src/identity/auth-service.ts src/identity/email-canonical.ts src/server/routes/auth.ts src/server/app.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): AuthService register 状态机(canonical 身份重入/per-op bootstrap/CAS 三元/Stripe 幂等/email 归一化)+login 经目录+老用户兼容

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

- [ ] **Step 1: updateEmail 经目录（红→绿）**

`user-email-directory-service.ts:46-56`：唯一性检查 → `directory.resolveByEmail(newEmail)`（多库真源，返非 null 且 tenantId≠自己→拒）；改 email 成功后：`directory.removeLookup('email', oldEmail)` + `recordActiveLookup({tenantId, 'email', newEmail})`（在 `TenantIdentityDirectory` 加 `changeEmailLookup(tenantId, oldEmail, newEmail)` 原子封装于 coordinator 单事务）。per-tenant + 跨库唯一性测。

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
- **Placeholder 扫描**：DSL builder API 标「以 v078/v108 为准」（防自创非 placeholder）；legacy fixture「照末条 raw 风格加对应版本」是确定动作非 TBD。
- **类型一致**：`reserveTenant` 返 `{operationId, reservedByUs, canonicalTenantId, canonicalUserId}`、`activateTenant` 返 boolean、`resolveByEmail` 返 `{tenantId, userId, status}|null`、`resolveBy*Hash` 返 `{tenantId}|null`、`recordActiveLookup`/`removeLookup`/`changeEmailLookup`/`listPending` 全 Task 引用一致；`dirCmdReserve` 带 userId、`bootCmdMarkComplete`/`bootQueryByOperation`（per-op）一致；`idGen: {tenantId();userId()}` seam 一致；`canonicalizeEmail` 单一真源；`AUTH_REGISTRATION_RETRY` 新错误码在 Task 5 注册。
- **复杂度**：目录门面方法均单一职责、≤3 层缩进；三类 lookup 合表靠 `lookup_kind` 判别（非三表）；bootstrap per-op 表两列主键。register 序列虽长但线性（reserve→shard 单事务→CAS→签发），无深嵌套。恢复 worker reconcile 单循环。
- **向后兼容/破坏性**：回填迁移（含 email 归一化）保证零中断——Codex 致命项闭合；单库 coordinatorDb≡dbForTenant 等价现状；错误码路径（AUTH_EMAIL_EXISTS）保持；idGen 默认 randomUUID 生产行为不变。
