# 租户分片 Phase 0 · Plan 1c（Auth mixed-scope + coordinator identity directory）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐 task 实现。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 把「无 tenantId 的全局定位 + 租户级写」这类 mixed-scope 入口（register/login/SSO/SCIM/refresh/api-key）切到 coordinator identity directory 定位后再到正确 shard 读写，落地 spec §4.1 的 `PENDING → ACTIVE` reservation 状态机（唯一真跨库写序列）。

**Architecture:** 新建一张 coordinator 上的 `tenant_identity_directory` 表（email/refresh_token_hash/api_key_hash → tenantId 全局反查 + `PENDING/ACTIVE` 状态）。register/SSO 自生成 tenantId 时走「coordinator 先建 PENDING reservation（email 唯一约束挡并发）→ `dbForTenant` 写租户数据 → CAS `PENDING→ACTIVE`」。login/refresh/SSO/OIDC/SCIM/api-key 认证只认 `ACTIVE` 目录项定位 tenant，再到 `dbForTenant` 读写。恢复 worker 只补 ACTIVE、绝不自动取消 PENDING（Phase 0 防孤儿竞态）。单库下 `coordinatorDb() ≡ dbForTenant`，行为等价现状，零回归。

**Tech Stack:** TypeScript、`@wontlost-ltd/schema-dsl`（DSL 迁移）、kernel query/command 工厂（`packages/kernel/src/domain/...`）+ executor（`src/storage/executors/...`）、`TenantDbResolver`（`coordinatorDb()`/`dbForTenant()`）、`FakeMultiShardResolver`（2-shard + 独立 coordinator 断言脚手架）、node:test（`tsx --test` 快跑，`test:golden` 全门）。

## Global Constraints

- **零-LLM 内核铁律**：纯数据路由 + 目录表改造，绝不引入任何 LLM 调用/推理。
- **隔离双重约束**：定位得 tenantId 后，租户级读写必须 ① `resolver.dbForTenant(tenantId)` 选对 shard + ② SQL 带 `WHERE tenant_id=?`（或父归属 JOIN）。目录级全局反查走 `resolver.coordinatorDb()`。
- **mixed-scope 诚实**：目录表是**唯一**放全局唯一键（email/token_hash/key_hash）的地方；租户级表（users/api_keys/refresh_tokens）在各 shard 内仍带自己的约束，但**多库真源是目录表**。不得用某个固定 shard db 冒充协调库。
- **状态机在 spec 定死（§4.1），非 Plan 决定**：`PENDING → ACTIVE` reservation、不 2PC、email 唯一约束在目录表挡并发 register、只认 ACTIVE、**Phase 0 恢复 worker 绝不自动取消 PENDING**（shard 初始化未提交时取消会留不可定位租户）。
- **单库零回归**：`SingleDbResolver` 三方法返同一 db，`coordinatorDb()` 与 `dbForTenant()` 等价，所有现有 auth-api/sso/scim 测试必须仍绿。
- **迁移同步 6 处**（记忆 [[schema-dsl-migration-sync-points]]，本次是 schema-simple 类迁移）：① 迁移文件本体 ② 目录 `index.ts` 的 export/import/数组三处 ③ `version-map.ts` 的 `VERSION_MAP`。号取 **sqlite v123 / postgres v125** 之后（避开 server-raw v119-v122）。parity 期望 + legacy fixture + VERSION_MAP range 若 CI 报再补（先跑 `test:golden` 逐个抓）。
- **tenant-bound seam 不破**：register/SSO 写租户数据仍用 `new IdentityWriter(tenantId, tx)`（Plan 1b seam），ctor 原子绑 `(tenantId, tx)`。
- **fail-closed 不放开**：Plan 1c 不碰 `assertShardingActivationAllowed` / verified 级门（那是 Plan 3）。多库 `buildResolver` 仍 throw；Plan 1c 的多-shard 行为全靠 `FakeMultiShardResolver` 单测验证。
- **接口签名统一改造**：`AuthService`/`SsoUserService`/`ScimProvisioningService` ctor 从裸 `tx` 改收 `TenantDbResolver`；`registerAuth`（api-key 反查）从裸 `db` 改收 `resolver`。所有构造点（`routes/auth.ts:214/280`、`app.ts:753`、`auth-sso.ts:95`、`auth-oidc.ts:79`、`app-services.ts:93`、`app.ts:242`、测试）同步。

---

## File Structure

- **迁移**（新建目录表）：`packages/schema-dsl/src/migrations/server-simple/v123.ts`（`tenant_identity_directory`）+ 同步 `server-simple/index.ts`（export/import/数组）+ `version-map.ts`。
- **kernel 工厂**（目录表 SQL）：`packages/kernel/src/domain/identity/directory-queries.ts`（新建：insert PENDING / CAS ACTIVE / query by email / query by refresh-token-hash / query by api-key-hash / delete）。
- **executor**：`src/storage/executors/directory-executors.ts`（新建，包 kernel 工厂为 executor）+ `src/storage/executors/index.ts` 注册。
- **directory 服务**（协调库读写门面）：`src/identity/tenant-identity-directory.ts`（新建：`reserveTenant`/`activateTenant`/`resolveByEmail`/`resolveByRefreshTokenHash`/`resolveByApiKeyHash`/`recordRefreshToken`/`recordApiKey`）。
- **改造消费者**：
  - `src/identity/auth-service.ts`（ctor→resolver；register 走 reservation；login/refresh 经目录定位）。
  - `src/identity/sso-user-service.ts`（ctor→resolver；findOrCreateForSso 走 reservation；OIDC 经目录一致性检查）。
  - `src/enterprise/scim-provisioning-service.ts`（ctor→resolver；createUser 经目录定位）。
  - `src/server/plugins/auth.ts`（`registerAuth` 收 resolver；api-key hash 经目录反查）。
- **恢复 worker**：`src/identity/tenant-reservation-recovery.ts`（新建：扫 PENDING，shard 已初始化→CAS ACTIVE，未初始化→保留+告警，绝不取消）。
- **过渡服务收口**：`src/identity/user-email-directory-service.ts` + `src/enterprise/scim-tenant-directory.ts`（Plan 1b 建的过渡门面，coordinatorDb 背后指向真目录表）。
- **测试**：`src/test/unit/auth-mixed-scope-sharding.test.ts`（新建，FakeMultiShardResolver + 目录落 coordinator/user 落 shard/PENDING→ACTIVE/并发/崩溃收敛）+ `src/test/integration/auth-api.test.ts`（并发 register 端到端）。

---

## Task 1: coordinator 目录表迁移 `tenant_identity_directory`

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-simple/v123.ts`
- Modify: `packages/schema-dsl/src/migrations/server-simple/index.ts`（export/import/`SERVER_SIMPLE_MIGRATIONS` 数组三处）
- Modify: `packages/schema-dsl/src/version-map.ts`（`VERSION_MAP` 尾加条目）
- Test: `packages/schema-dsl/src/test/`（parity/roundtrip 现有测试自动覆盖）+ `src/test/unit/migrations.test.ts`（applied 计数）

**Interfaces:**
- Produces: 表 `tenant_identity_directory`，列 `tenant_id TEXT NOT NULL`、`shard_id TEXT`、`operation_id TEXT NOT NULL`、`lookup_kind TEXT NOT NULL CHECK IN ('email','refresh_token_hash','api_key_hash')`、`lookup_value TEXT NOT NULL`、`status TEXT NOT NULL CHECK IN ('PENDING','ACTIVE')`、`created_at`、`updated_at`。约束：`UNIQUE(lookup_kind, lookup_value)`（email/hash 全局唯一，挡并发 register）；索引 `idx_tid_tenant (tenant_id)`、`idx_tid_lookup (lookup_kind, lookup_value)`。

- [ ] **Step 1: 参照现有迁移形态**

先 Read `packages/schema-dsl/src/migrations/server-simple/v078.ts`（state 列 + CHECK 枚举）+ `v108.ts`（partial-unique）+ 目录里最近一条 schema-simple 迁移，照抄 `defineMigration`/DSL builder 用法与命名风格（表名/列名 snake_case、迁移变量名 `v123_tenant_identity_directory`）。

- [ ] **Step 2: 写迁移文件 v123.ts**

```ts
// packages/schema-dsl/src/migrations/server-simple/v123.ts
// 租户身份目录：多库下 email/refresh-token/api-key hash → tenant 的全局反查 + PENDING/ACTIVE reservation。
import { defineMigration } from '../../dsl';  // ← 按现有迁移的实际 import 路径校正

export const v123_tenant_identity_directory = defineMigration({
  version: 'v123_tenant_identity_directory',
  up: (t) => {
    t.createTable('tenant_identity_directory', (c) => {
      c.text('tenant_id').notNull();
      c.text('shard_id');
      c.text('operation_id').notNull();
      c.text('lookup_kind').notNull().check("lookup_kind IN ('email','refresh_token_hash','api_key_hash')");
      c.text('lookup_value').notNull();
      c.text('status').notNull().check("status IN ('PENDING','ACTIVE')");
      c.integer('created_at').notNull();
      c.integer('updated_at').notNull();
      c.unique(['lookup_kind', 'lookup_value']);   // 全局唯一 → 挡并发 register
    });
    t.createIndex('idx_tid_tenant', 'tenant_identity_directory', ['tenant_id']);
    t.createIndex('idx_tid_lookup', 'tenant_identity_directory', ['lookup_kind', 'lookup_value']);
  },
});
```
> 注：`defineMigration`/`t.createTable`/`c.text().check()` 的确切 API 以 v078/v108 实际写法为准 —— 用它们已验证过 SQLite+PG 两 renderer 的形态，别自创 builder 方法名。CHECK/UNIQUE 在两 renderer 都要能渲染（v078 的 CHECK、v108 的 unique 已证）。

- [ ] **Step 3: 同步 index.ts 三处**

在 `packages/schema-dsl/src/migrations/server-simple/index.ts`：
1. `export { v123_tenant_identity_directory } from './v123';`（export 段末尾，紧跟现有 v118 那条的风格）。
2. `import { v123_tenant_identity_directory } from './v123';`（import 段末尾）。
3. `SERVER_SIMPLE_MIGRATIONS` 数组末尾加 `v123_tenant_identity_directory,`。

- [ ] **Step 4: 同步 version-map.ts**

在 `packages/schema-dsl/src/version-map.ts` 的 `VERSION_MAP` 数组尾部加（postgres 号取 v125，比 sqlite 高 2，与现有偏移一致；确切别名格式照抄末条 `v122_github_draft_published`）：
```ts
{ canonical: 'v123_tenant_identity_directory',
  aliases: { postgres: 'v125_tenant_identity_directory', 'sqlite-sql': 'v123_tenant_identity_directory' },
  classification: 'schema-simple' },
```

- [ ] **Step 5: 跑迁移相关测试**

Run: `npm run build --workspace=@wontlost-ltd/schema-dsl 2>&1 | tail -5`（重建 schema-dsl dist，记忆 [[schema-dsl-migration-sync-points]] 必须）
Run: `npx tsx --test src/test/unit/migrations.test.ts src/test/integration/schema-dsl-sqlite-parity.test.ts src/test/integration/schema-dsl-pg-parity.test.ts 2>&1 | tail -20`
Expected: 全绿。若 parity 报「Missing DSL migration / count mismatch」→ 说明 6 同步点漏了某处（parity 期望数组 / legacy fixture 两数组 / VERSION_MAP range），逐个补齐再跑。

- [ ] **Step 6: Commit**

```bash
git add packages/schema-dsl/src/migrations/server-simple/v123.ts packages/schema-dsl/src/migrations/server-simple/index.ts packages/schema-dsl/src/version-map.ts packages/schema-dsl/dist
git commit -m "feat(shard): coordinator tenant_identity_directory 表迁移(email/token/key→tenant + PENDING/ACTIVE)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 目录表 kernel 工厂 + executor

**Files:**
- Create: `packages/kernel/src/domain/identity/directory-queries.ts`
- Modify: `packages/kernel/src/domain/identity/index.ts`（若有导出桶）
- Create: `src/storage/executors/directory-executors.ts`
- Modify: `src/storage/executors/index.ts`（注册 executor）
- Test: `src/test/unit/directory-executors.test.ts`

**Interfaces:**
- Produces（kernel query/command 工厂，签名照抄同目录现有工厂如 `auth-executors` 引用的 kernel 工厂风格）：
  - `dirCmdReserve({ tenantId, shardId, operationId, lookupKind, lookupValue, now }): WriteCommand` → `INSERT INTO tenant_identity_directory (...) VALUES (...)` status `'PENDING'`。
  - `dirCmdActivate({ operationId, lookupKind, lookupValue, now }): WriteCommand` → `UPDATE ... SET status='ACTIVE', updated_at=? WHERE lookup_kind=? AND lookup_value=? AND operation_id=? AND status='PENDING'`（CAS：靠 rowsAffected 判定）。
  - `dirQueryByLookup(lookupKind, lookupValue): Query` → `SELECT tenant_id, shard_id, status, operation_id FROM tenant_identity_directory WHERE lookup_kind=? AND lookup_value=? LIMIT 1`。
  - `dirQueryPendingBefore(cutoff): Query` → `SELECT ... WHERE status='PENDING' AND updated_at < ?`（恢复 worker 用）。
- Produces（executor，包 kernel 工厂）：同名 `dirCmdReserve`/`dirCmdActivate`/`dirQueryByLookup`/`dirQueryPendingBefore` 从 `directory-executors.ts` 导出，供 service 层调。

- [ ] **Step 1: 写 executor 单测（红）**

先 Read `src/storage/executors/api-key-executors.ts` + `src/test/unit/`（找一个 executor 单测样例）对齐风格。测：insert PENDING 后 `dirQueryByLookup` 命中 status=PENDING；`dirCmdActivate` 后 status=ACTIVE 且 rowsAffected=1；对已 ACTIVE 再 activate → rowsAffected=0（CAS 幂等）；重复 lookup_value insert → UNIQUE 冲突 throw。用内存 sqlite + `runDslSqliteMigrations`（照抄 appservices-tenant-scoped-sharding.test.ts 的 seed 脚手架）建表。

```ts
// src/test/unit/directory-executors.test.ts（骨架，具体断言按上）
test('reserve → PENDING, activate → ACTIVE via CAS, re-activate no-op', () => {
  const db = /* 内存 sqlite + 迁移 */;
  db.execute(dirCmdReserve({ tenantId: 't1', shardId: 's1', operationId: 'op1',
    lookupKind: 'email', lookupValue: 'a@x.com', now: 1 }));
  const pending = db.queryOne(dirQueryByLookup('email', 'a@x.com'));
  assert.equal(pending.status, 'PENDING');
  const r1 = db.execute(dirCmdActivate({ operationId: 'op1', lookupKind: 'email', lookupValue: 'a@x.com', now: 2 }));
  assert.equal(r1.rowsAffected, 1);
  const r2 = db.execute(dirCmdActivate({ operationId: 'op1', lookupKind: 'email', lookupValue: 'a@x.com', now: 3 }));
  assert.equal(r2.rowsAffected, 0);  // 已 ACTIVE，CAS 不再命中
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/test/unit/directory-executors.test.ts 2>&1 | tail -15`
Expected: FAIL（`dirCmdReserve` 等未定义）。

- [ ] **Step 3: 写 kernel 工厂 + executor**

按 Interfaces 的 SQL 写 `directory-queries.ts`（照抄 `api-key-queries.ts` 的工厂签名/返回类型）+ `directory-executors.ts`（包工厂，照抄 `api-key-executors.ts`）+ 在 `src/storage/executors/index.ts` 注册。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/test/unit/directory-executors.test.ts 2>&1 | tail -15`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src src/storage/executors/directory-executors.ts src/storage/executors/index.ts src/test/unit/directory-executors.test.ts
git commit -m "feat(shard): 目录表 kernel 工厂+executor(reserve PENDING/CAS activate/lookup)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `TenantIdentityDirectory` 协调库门面服务

**Files:**
- Create: `src/identity/tenant-identity-directory.ts`
- Test: `src/test/unit/tenant-identity-directory.test.ts`

**Interfaces:**
- Consumes: `dirCmd*/dirQuery*`（Task 2）、`TenantDbResolver.coordinatorDb()`。
- Produces（`TenantIdentityDirectory` 类，ctor `constructor(private readonly resolver: TenantDbResolver)`）：
  - `reserveTenant(args: { tenantId; shardId; operationId; email }): void` — 在 coordinator 建 email PENDING（UNIQUE 冲突向上抛，调用方转 `AUTH_EMAIL_EXISTS`）。
  - `activateTenant(args: { operationId; email }): boolean` — CAS PENDING→ACTIVE，返回 rowsAffected===1。
  - `resolveByEmail(email): { tenantId; shardId; status } | null` — 全局定位；调用方只认 status==='ACTIVE'。
  - `resolveByRefreshTokenHash(hash): { tenantId; shardId } | null` — 只认 ACTIVE。
  - `resolveByApiKeyHash(hash): { tenantId; shardId } | null` — 只认 ACTIVE。
  - `recordRefreshToken(args: { tenantId; shardId; operationId; tokenHash }): void` — 直接建 ACTIVE 目录项（token 由已 ACTIVE 租户签发，无 reservation 两段）。
  - `recordApiKey(args: { tenantId; shardId; operationId; keyHash }): void` — 同上。
  - `removeRefreshToken(hash)` / `removeApiKey(hash)` — 撤销时清目录项（revoke/logout 用）。

- [ ] **Step 1: 写门面单测（红）**

用 `FakeMultiShardResolver`（`src/test/support/fake-multi-shard-resolver.ts`，coordinator 独立 db）。断言 `reserveTenant` 写落 **coordinator db**（非任何 shard），`resolveByEmail` 在 PENDING 时返 status=PENDING（调用方将拒），activate 后返 ACTIVE；`resolveByRefreshTokenHash` 只在 ACTIVE 项命中。参照 `appservices-tenant-scoped-sharding.test.ts` 的 coordinator 断言写法（`coordinator.queryOne(...)` truthy / `shard.queryOne(...)` undefined）。

- [ ] **Step 2: 跑测试确认失败** — `npx tsx --test src/test/unit/tenant-identity-directory.test.ts`，Expected FAIL（类未定义）。

- [ ] **Step 3: 写 `TenantIdentityDirectory`**

每个方法 `this.resolver.coordinatorDb()` 取协调库 + 调 Task 2 的 executor。`resolveBy*` 把 `dirQueryByLookup` 结果按 `lookupKind` 过滤（email 项对 email 反查，等）。`resolveByRefreshTokenHash/resolveByApiKeyHash` 内部 `if (row.status !== 'ACTIVE') return null;`。

- [ ] **Step 4: 跑测试确认通过** — Expected PASS。

- [ ] **Step 5: Commit**

```bash
git add src/identity/tenant-identity-directory.ts src/test/unit/tenant-identity-directory.test.ts
git commit -m "feat(shard): TenantIdentityDirectory 协调库门面(reserve/activate/resolve by email·token·key)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AuthService register → reservation 状态机

**Files:**
- Modify: `src/identity/auth-service.ts:57-136`（ctor + register + login + refresh）
- Modify: `src/server/routes/auth.ts:211-280`（`registerAuthRoutes` 传 resolver）
- Modify: `src/server/app.ts:753`（传 resolver 而非裸 db）
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（新建）+ `src/test/integration/auth-api.test.ts`（现有回归）

**Interfaces:**
- Consumes: `TenantIdentityDirectory`（Task 3）、`TenantDbResolver`、`IdentityWriter`（Plan 1b seam）。
- Produces: `AuthService` ctor `constructor(private readonly resolver: TenantDbResolver, private readonly config: AppConfig)`；内部 `private directory = new TenantIdentityDirectory(this.resolver)`。register/login/refresh 行为契约不变（HTTP 层返回相同结构），只是定位 tenant 的路径改经 directory。

- [ ] **Step 1: 写状态机行为测（红）**

`auth-mixed-scope-sharding.test.ts` 用 `FakeMultiShardResolver`（2 shard + 独立 coordinator）：
1. **register 落点**：register(email) → coordinator 有 email ACTIVE 目录项（tenantId/shardId 记对）+ 对应 shard 有 user 行 + **其他 shard 无** user 行。
2. **PENDING→ACTIVE 时序**：注入一个「dbForTenant 写 user 抛错」的 fake → 断言 coordinator 仍留 PENDING（未 CAS 到 ACTIVE），user 未落任何 shard（写事务回滚）。
3. **并发/重复 register**：同 email 第二次 register → coordinator UNIQUE 冲突 → 抛 `AUTH_EMAIL_EXISTS`，不生第二个 tenantId、不写第二 shard。
4. **崩溃收敛（CAS 前崩）**：模拟 reservation 建了但 shard 写前进程「崩」（不调 activate）→ 目录留 PENDING；重试同 operationId 幂等确认不重生 tenantId（reserve 用稳定 operationId，UNIQUE 挡）。
5. **login 经目录**：register 后 login(email) → 经 `resolveByEmail` 得 ACTIVE tenantId → `dbForTenant` 验密码 → 成功；对 PENDING 项 login → 拒（视作未完成）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（AuthService 还收裸 tx）。

- [ ] **Step 3: 改 register 走状态机**

register（替换 `auth-service.ts:65-102`）新序列：
```
1. operationId = 稳定生成（randomUUID，同次请求内固定；重试语义见 Step 1.4 注）
2. tenantId = `tenant_${randomUUID()}`; userId = randomUUID(); shardId = resolver.shardIdForTenant?(tenantId) ?? 'home'
   （shardId 供目录记录；单库/SingleDbResolver 下为 home）
3. directory.reserveTenant({ tenantId, shardId, operationId, email })  // UNIQUE 冲突 → catch 转 AUTH_EMAIL_EXISTS
4. const tx = resolver.dbForTenant(tenantId);
   在 tx 内建 user/subscription/quota/identity（原 :76/:90/:94/:98 全从 this.tx 改 tx；identity 仍 new IdentityWriter(tenantId, tx)）
5. directory.activateTenant({ operationId, email })  // CAS PENDING→ACTIVE；若返 false 记告警（恢复 worker 补）
6. generateTokenPair(...)
```
login（替换 `:104-117`）：`const entry = directory.resolveByEmail(email); if (!entry || entry.status !== 'ACTIVE') throw INVALID_CREDENTIALS; const tx = resolver.dbForTenant(entry.tenantId); const user = tx.queryOne(authQueryUserByEmail(email)); ...`（在正确 shard 验密码；`user.tenant_id` 应 === entry.tenantId）。
refresh（`:119-136`）：**refresh_token_hash → tenant 经目录**（Task 6 补全 recordRefreshToken 后此处 `directory.resolveByRefreshTokenHash(tokenHash)` 得 tenantId → `dbForTenant` 查 token/user）。本 Task 先让 refresh 编译通过（可暂经目录 resolveByEmail 不适用——refresh 无 email）；**refresh 完整定位留 Task 6**，本 Task 的 refresh 只保证 ctor 改造后不破，标注 `// Task 6: refresh_token_hash→tenant via directory`。

- [ ] **Step 4: 同步构造点**

`routes/auth.ts:211` `registerAuthRoutes(app, resolver, config)` + `:214/:280` `new AuthService(resolver, config)`；`app.ts:753` 传 `resolver`。`auth-api.test.ts` 若直 new AuthService 则同步（多数经 createApp，不用改）。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/integration/auth-api.test.ts 2>&1 | tail -20`
Expected: 新测全 PASS，auth-api 回归全绿（单库下 coordinatorDb≡dbForTenant，register/login 等价现状）。

- [ ] **Step 6: Commit**

```bash
git add src/identity/auth-service.ts src/server/routes/auth.ts src/server/app.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): AuthService register 走 coordinator reservation(PENDING→CAS ACTIVE)+login 经目录定位

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: SSO/OIDC + SCIM createUser 经目录定位

**Files:**
- Modify: `src/identity/sso-user-service.ts:28-95`（ctor→resolver；findOrCreateForSso 走 reservation；OIDC 经目录一致性）
- Modify: `src/server/routes/auth-sso.ts:95`、`src/server/routes/auth-oidc.ts:79`（传 resolver）
- Modify: `src/enterprise/scim-provisioning-service.ts:70-142`（ctor→resolver；createUser 全局 email 查经目录）
- Modify: `src/server/app-services.ts:93`（`new ScimProvisioningService(resolver, ...)`）
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（追加 SSO/SCIM 用例）+ 现有 `stripe-auth-sso.test.ts` / `scim-compliance-evidence.test.ts` 回归

**Interfaces:**
- Consumes: `TenantIdentityDirectory`、`TenantDbResolver`、`IdentityWriter`。
- Produces: `SsoUserService` ctor `(resolver: TenantDbResolver)`；`ScimProvisioningService` ctor `(resolver, evidenceRecorder?, evidenceFailureSink?)`。`findOrCreateForOidc`/`findOrCreateForSso`/`createUser` 签名与返回不变。

- [ ] **Step 1: 追加 SSO/SCIM 行为测（红）**

- SSO 自生成 tenant（`findOrCreateForSso`）：走 reservation → coordinator email ACTIVE + 正确 shard 有 user。
- OIDC email 一致性（`findOrCreateForOidc(email, expectedTenantId)`）：目录里 email 已属**其他** tenant → 抛 `AUTH_SSO_FAILED`（多库下从 coordinator 目录判定，非某 shard 的 users 查）。
- SCIM `createUser(tenantId, {email})`：目录里 email 已属其他 tenant → 抛「已存在于其他 tenant」；新建 → coordinator ACTIVE + tenantId 对应 shard 有 user。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（ctor 裸 tx）。

- [ ] **Step 3: 改 SSO/SCIM**

- `sso-user-service.ts`：ctor `(private readonly resolver)`；`private directory = new TenantIdentityDirectory(resolver)`；`identityWriter(tenantId)` 改 `new IdentityWriter(tenantId, this.resolver.dbForTenant(tenantId))`。`findOrCreateForOidc` 的 `:47` 全局 email 查 → `directory.resolveByEmail(email)`（只认 ACTIVE），`:50` 一致性检查对 `entry.tenantId` 比 `expectedTenantId`；新建走 `dbForTenant(expectedTenantId)`。`findOrCreateForSso` 自生成 tenant 走 reservation（同 Task 4 序列）。
- `scim-provisioning-service.ts`：ctor `(private readonly resolver, ...)`；`:117` 全局 email 查 → `directory.resolveByEmail`；`:126/:128/:130` 写走 `dbForTenant(tenantId)`。SCIM 的 tenantId 是目标租户给的（非自生成），故 createUser 是「目录登记 email→已知 tenantId + shard 写」，不走 PENDING 两段（除非 email 全新则建 ACTIVE 目录项 + shard 写，用 reserve+activate 或直接 recordActive——按 email 是否已存在决定，全新 email 用 reserve→写→activate 保一致）。
- 同步 `auth-sso.ts:95`/`auth-oidc.ts:79`/`app-services.ts:93` 传 resolver。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/unit/stripe-auth-sso.test.ts src/test/integration/scim-compliance-evidence.test.ts 2>&1 | tail -20`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/identity/sso-user-service.ts src/server/routes/auth-sso.ts src/server/routes/auth-oidc.ts src/enterprise/scim-provisioning-service.ts src/server/app-services.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): SSO/OIDC+SCIM createUser 经 coordinator 目录定位 email→tenant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: refresh_token + api_key hash→tenant 目录反查

**Files:**
- Modify: `src/identity/auth-service.ts`（refresh 完整定位 + register/login 签发 token 时 `recordRefreshToken`；revoke/logout 时 `removeRefreshToken`）
- Modify: `src/server/plugins/auth.ts:52-160`（`registerAuth` 收 resolver；api-key hash 经目录反查）
- Modify: `src/server/app.ts:242`（`registerAuth(app, config, resolver)`）
- Modify: `src/billing/api-key-service.ts`（创建 api-key 时 `recordApiKey`；revoke 时 `removeApiKey`）
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（追加 refresh/api-key 用例）+ 现有 api-key 测试回归

**Interfaces:**
- Consumes: `TenantIdentityDirectory.recordRefreshToken/resolveByRefreshTokenHash/removeRefreshToken/recordApiKey/resolveByApiKeyHash/removeApiKey`（Task 3）。
- Produces: `registerAuth(app, config, resolver: TenantDbResolver)`。refresh/api-key 认证行为契约不变，定位路径改经目录。

- [ ] **Step 1: 追加 refresh/api-key 行为测（红）**

- refresh：register/login 签发 refresh token → 目录有 token_hash→tenant ACTIVE 项 → refresh(token) 经 `resolveByRefreshTokenHash` 得 tenantId → `dbForTenant` 查 token 未撤销 → 发新 access。跨 shard：token 属 shard s1，从 coordinator 反查得 s1，不误查 s0。
- api-key：创建 api-key → 目录有 key_hash→tenant ACTIVE 项 → `registerAuth` 的 preHandler 用 hash 经 `resolveByApiKeyHash` 得 tenantId → `dbForTenant` 验 key 未撤销。跨 shard 同理。
- revoke：logout/revoke → `removeRefreshToken`/`removeApiKey` 清目录项 → 后续反查返 null。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 改 refresh/api-key 定位**

- `auth-service.ts` refresh：`const entry = directory.resolveByRefreshTokenHash(tokenHash); if (!entry) throw INVALID; const tx = resolver.dbForTenant(entry.tenantId); const row = tx.queryOne(authQueryRefreshToken(tokenHash)); ...`。签发 refresh token（register/login/refresh 处）后 `directory.recordRefreshToken({ tenantId, shardId, operationId, tokenHash })`；撤销时 `removeRefreshToken`。
- `server/plugins/auth.ts`：`registerAuth(app, config, resolver)`；`:144` `const entry = resolver ? new TenantIdentityDirectory(resolver).resolveByApiKeyHash(keyHash) : null; const tx = entry ? resolver.dbForTenant(entry.tenantId) : /* 单库回退 host */; const row = tx.queryOne(apikeyQueryByHash(keyHash));`。保留 `:160` catch 静默回退语义（认证失败不 500）。
- `api-key-service.ts`：创建 key 时 `directory.recordApiKey(...)`；revoke 时 `removeApiKey(...)`。
- 同步 `app.ts:242`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/unit/appservices-tenant-scoped-sharding.test.ts 2>&1 | tail -20`
Expected: 全绿（含 Plan 1b ApiKey 管理方法回归）。

- [ ] **Step 5: Commit**

```bash
git add src/identity/auth-service.ts src/server/plugins/auth.ts src/server/app.ts src/billing/api-key-service.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): refresh_token+api_key hash→tenant 经 coordinator 目录反查(多库真隔离)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: PENDING 恢复 worker（绝不自动取消）

**Files:**
- Create: `src/identity/tenant-reservation-recovery.ts`
- Modify: `src/server/app.ts`（装配 worker，经 resolver.coordinatorDb() 扫 + resolver 判 shard 初始化）
- Test: `src/test/unit/tenant-reservation-recovery.test.ts`

**Interfaces:**
- Consumes: `TenantIdentityDirectory`（`resolveByEmail`/`activateTenant` + 新增 `listPending(cutoff)`）、`TenantDbResolver`。
- Produces: `TenantReservationRecovery` 类，`reconcile(now): { activated: number; retained: number }` —— 扫 PENDING：查对应 tenant shard 是否已初始化（user 行存在）→ 是则 CAS 补 ACTIVE（activated++）；否则**保留 PENDING + 记告警**（retained++），**绝不删/取消**。

- [ ] **Step 1: 写恢复 worker 测（红）**

用 `FakeMultiShardResolver`。造两个 PENDING：A 的 shard 已有 user 行（模拟 shard 写成功但 CAS 丢）、B 的 shard 无 user 行（模拟 shard 写未提交/未开始）。`reconcile()` → A 变 ACTIVE（activated=1）、B **仍 PENDING**（retained=1，未删）。断言 B 的目录项在 reconcile 后仍在（`resolveByEmail` 返 PENDING，非 null）——这是 spec §4.1.6 防孤儿竞态的核心断言。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 写 `TenantReservationRecovery`**

```
reconcile(now):
  for each pending in directory.listPending(cutoff = now - GRACE):
    const tx = resolver.dbForTenant(pending.tenantId);
    const initialized = tx.queryOne(authQueryUserCountByTenant(pending.tenantId))?.count > 0;
    if (initialized) { directory.activateTenant({ operationId, email }); activated++; }
    else { logger.warn('reservation retained, shard not initialized', { tenantId, operationId }); retained++; }  // 绝不取消
```
`listPending` 加到 `TenantIdentityDirectory`（Task 3，用 `dirQueryPendingBefore`）。

- [ ] **Step 4: 跑测试确认通过** — Expected PASS。

- [ ] **Step 5: 装配 worker（app.ts）**

在 app.ts worker 装配区加 `TenantReservationRecovery`（照抄现有 timer worker 装配模式，如 SettlementReconciliationWorker）。经 resolver 装配（非裸 db）。**Phase 0 只调 reconcile 的补 ACTIVE 分支，不启用任何取消逻辑**（代码里根本没写取消）。

- [ ] **Step 6: Commit**

```bash
git add src/identity/tenant-reservation-recovery.ts src/identity/tenant-identity-directory.ts src/server/app.ts src/test/unit/tenant-reservation-recovery.test.ts
git commit -m "feat(shard): PENDING reservation 恢复 worker(shard 已初始化补 ACTIVE，未初始化保留+告警绝不取消)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 过渡服务收口 + inventory 校准 + 全门验收

**Files:**
- Modify: `src/identity/user-email-directory-service.ts`（updateEmail 唯一性检查改经 `TenantIdentityDirectory` 而非 users 本表）
- Modify: `src/enterprise/scim-tenant-directory.ts`（若 token→tenant 归并进目录；否则保持 coordinatorDb 语义 + 标注）
- Modify: `src/storage/db-access-inventory.ts`（mixed-scope edge 从 planned → wired/verified；directory 服务 edge 登记）
- Test: `src/test/unit/db-access-inventory-completeness.test.ts`（回归门）+ `npm run check:db-access` + `npm run test:golden`

**Interfaces:**
- Consumes: `TenantIdentityDirectory`。

- [ ] **Step 1: updateEmail 经目录唯一性检查**

`user-email-directory-service.ts:46-56`：`uprofQueryByEmailExclude`（查 users 本表）→ 改用 `directory.resolveByEmail(email)` 判全局唯一（多库真源）；改 email 时同步更新目录项（`removeRefreshToken` 不涉及，但 email 目录项要 `directory` 更新 lookup_value）。加对应 `updateEmailInDirectory` 方法到 Task 3 的门面（若 Step 未覆盖）。写 per-tenant + 跨库唯一性测（红→绿）。

- [ ] **Step 2: inventory 逐 edge 校准**

`db-access-inventory.ts`：AuthService/SsoUserService/ScimProvisioningService/registerAuth 的 mixed-scope edge —— 现在真经 directory + dbForTenant + 有 2-shard 测覆盖 → 从 `planned` 升 `verified`（**逐 edge，且必须真有 auth-mixed-scope-sharding.test.ts 覆盖才升**）。`TenantIdentityDirectory` 门面 edge 登记为 coordinator 定位（新 disposition）。**绝不 mass-upgrade**：仍携带 root-db/未测能力的保持 planned。重算每组 `expectedCount === coveredEdgeIds.length`（记忆：fingerprint 校验）。

- [ ] **Step 3: 全门验收**

Run: `npm run typecheck 2>&1 | tail -5`（所有 ctor 签名改造点编译通过）
Run: `npm run check:db-access 2>&1 | tail -15`（五诊断全空；mixed-scope edge 分类准确 verified/planned）
Run: `rg -n 'new AuthService\(|new SsoUserService\(|new ScimProvisioningService\(|registerAuth\(' src | rg -v 'resolver'`（确认无残留裸 db/tx 构造点；命中都应带 resolver）
Expected: check:db-access 绿；rg 无裸构造残留（或仅注释）。

- [ ] **Step 4: test:golden 全门**

Run: `npm run test:golden 2>&1 | tail -30`
Expected: **EXIT 0**，无 `fail N>0`，链走到最后一个门（db-access）。verify 无假绿：确认 unit/integration/contract/packages/ga:check 逐个绿。

- [ ] **Step 5: Commit**

```bash
git add src/identity/user-email-directory-service.ts src/enterprise/scim-tenant-directory.ts src/storage/db-access-inventory.ts src/test/unit/db-access-inventory-completeness.test.ts
git commit -m "feat(shard): Plan 1c 收口——过渡目录服务经真目录表+inventory mixed-scope edge 校准 verified

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（写完计划后自检）

- **Spec 覆盖**：§4.1 coordinator identity directory ✅（Task 1-3）；PENDING→ACTIVE reservation ✅（Task 4）；只认 ACTIVE ✅（Task 4 login + Task 5/6 resolve）；email 唯一挡并发 register ✅（Task 1 UNIQUE + Task 4.1.3 测）；register 每步崩溃收敛 ✅（Task 4.1.4 + Task 7）；PENDING 不自动取消竞态 ✅（Task 7）；token/key 反查（用户选的扩展范围）✅（Task 6）。
- **Placeholder 扫描**：无 TBD；每个 code step 有骨架代码或精确 SQL/签名。DSL builder API 明确标「以 v078/v108 实际写法为准」（非 placeholder，是防自创 API）。
- **类型一致**：`TenantDbResolver.coordinatorDb()`/`dbForTenant()` 全 Task 一致；`TenantIdentityDirectory` 方法名 reserveTenant/activateTenant/resolveBy* 全 Task 引用一致；`operationId`/`lookupKind`/`status` 列名与 Task 1 迁移一致。
- **迁移同步**：Task 1 显式列 6 处（记忆 [[schema-dsl-migration-sync-points]]）+ 必重建 dist。
- **诚实性**：inventory 校准（Task 8）显式「逐 edge、有测才升 verified、绝不 mass-upgrade」，对齐 Plan 1b 铁律。
- **fail-closed 不放开**：全程不碰 assertShardingActivationAllowed（Plan 3 才放开），多-shard 全靠 FakeMultiShardResolver 单测——已在 Global Constraints 声明。
