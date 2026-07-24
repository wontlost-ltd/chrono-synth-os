# 租户分片 Phase 0 · Plan 1c（Auth mixed-scope + coordinator identity directory）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐 task 实现。步骤用 checkbox（`- [ ]`）跟踪。
>
> **第 2 轮修订**：采纳 Codex 独立复审 57/100 退回的 8 项确认缺陷——① operationId 确定性重入（非随机）② 老用户 login 致命兼容→回填迁移 ③ shard 原子完成标记(bootstrap ledger) ④ CAS 失败不签发 token ⑤ 目录=定位器、shard is_revoked=权威（消双写一致性依赖）⑥ revoke-by-hash 接口 ⑦ 目录不存 shardId（tenantId 纯函数派生，消 `shardIdForTenant()` 幽灵方法 + 修 fake）⑧ 6 迁移同步点全显式。

**Goal:** 把「无 tenantId 的全局定位 + 租户级写」这类 mixed-scope 入口（register/login/SSO/SCIM/refresh/api-key）切到 coordinator identity directory 定位后再到正确 shard 读写，落地 spec §4.1 的 `PENDING → ACTIVE` reservation 状态机（唯一真跨库写序列），**且升级前的历史用户无缝可用**。

**Architecture:** coordinator 上建 `tenant_identity_directory`（`lookup_kind ∈ {email,refresh_token_hash,api_key_hash}` × `lookup_value` → `tenant_id` 全局反查 + `PENDING/ACTIVE`）。

关键设计决策（回应 Codex）：
- **目录=定位器，权威在 shard**：目录项只回答「这个 email/token/key 属哪个 tenant」；账号是否有效（密码、is_revoked、过期）永远以 `dbForTenant(tenantId)` 的 shard 内行为权威真源。故目录与 shard 的「双写」不需要原子/2PC——目录项过期/多余只导致「定位到一个 shard 后在 shard 上验证失败」（安全的拒绝），绝不导致越权。撤销以 shard `is_revoked` 为准，目录项清理是尽力而为的垃圾回收（清晚了不影响正确性，因 shard 已拒）。
- **目录不存 shardId**：shardId 是 `tenantId` 的纯函数（`shardIdForTenant(tenantId, shardIds)`，`shard-hash.ts`，`dbForTenant` 内部即用它）。存 shardId 是会漂移的冗余，故目录只存 `tenant_id`，路由永远靠 `resolver.dbForTenant(tenantId)`。**无需给 resolver 加 `shardIdForTenant()` 方法**。
- **确定性 operationId**：`operationId = 'reg:' + sha256(lookup_kind + ':' + lookup_value)`（对 register 即 email）。同 email 重试恒得同 operationId，reserve 幂等（`INSERT ... ON CONFLICT(lookup_kind,lookup_value) DO NOTHING` + 读回校验 operationId 属己），不靠「撞 UNIQUE 报错」兜底。
- **shard bootstrap 完成标记**：register 在 `dbForTenant(tenantId)` 的**单个事务**内写 user/subscription/quota/identity **加一行 `tenant_bootstrap(tenant_id, operation_id, status='COMPLETE')`**。CAS activate 与恢复 worker 都以此标记为「shard 初始化完成」的判据（非「user 行恰好存在」——半初始化也可能有 user 行）。
- **CAS 失败不签发 token**：`activateTenant` 返 false（PENDING 已被他人激活/不存在）→ 不发 token，抛可重试错误（客户端重试幂等收敛）。

register/SSO 自生成 tenantId 序列：`reserve PENDING（确定性 opId，ON CONFLICT DO NOTHING）→ dbForTenant 单事务写租户数据+bootstrap COMPLETE 标记 → CAS PENDING→ACTIVE → 仅 CAS 成功才签发 token`。login/refresh/SSO/OIDC/SCIM/api-key 只认 `ACTIVE` 目录项定位 tenant，再到 shard 权威验证。恢复 worker 只补 ACTIVE（凭 bootstrap COMPLETE）、绝不取消 PENDING。**新增回填迁移**把升级前 users/api_keys/refresh_tokens 写成 ACTIVE 目录项，老用户无缝。单库下 `coordinatorDb() ≡ dbForTenant`，行为等价现状。

**Tech Stack:** TypeScript、`@wontlost-ltd/schema-dsl`（DSL 迁移）、kernel query/command 工厂 + executor、`TenantDbResolver`、`shardIdForTenant`（`src/storage/shard-hash.ts` 纯函数）、`FakeMultiShardResolver`（2-shard + 独立 coordinator）、node:test。

## Global Constraints

- **零-LLM 内核铁律**：纯数据路由 + 目录表改造，绝不引入 LLM。
- **绝不破坏用户空间（铁律）**：升级前用户/token/api-key 必须继续可用——回填迁移（Task 2）是硬前置，其后所有「目录硬前置定位」的 Task 才允许合入。
- **目录=定位器、shard=权威**：目录项只定位 tenant；有效性（密码/is_revoked/过期）永远 shard 权威。目录↔shard 无需原子双写。
- **隔离双重约束**：定位得 tenantId 后，租户级读写 ① `resolver.dbForTenant(tenantId)` + ② SQL `WHERE tenant_id=?`（或父归属 JOIN）。目录级全局反查走 `resolver.coordinatorDb()`。
- **状态机 spec 定死（§4.1）**：PENDING→ACTIVE、不 2PC、email 唯一挡并发、只认 ACTIVE、**恢复 worker 绝不自动取消 PENDING**。operationId 确定性、bootstrap 完成标记、CAS 失败不发 token 是本轮为落地状态机而定的实现约束。
- **单库零回归**：`SingleDbResolver` 三方法返同一 db，现有 auth-api/sso/scim 测试仍绿。回填迁移在单库下也跑（把本库 users→本库目录 ACTIVE），login 改造后老用户仍通。
- **tenant-bound seam 不破**：写租户数据用 `new IdentityWriter(tenantId, tx)`（Plan 1b seam）。
- **fail-closed 不放开**：不碰 `assertShardingActivationAllowed`/verified 门（Plan 3）。多-shard 行为全靠 `FakeMultiShardResolver` 单测。
- **迁移同步 6 处**（记忆 [[schema-dsl-migration-sync-points]]，schema-simple 类）：① 迁移文件本体 ② `server-simple/index.ts` 的 export/import/`SERVER_SIMPLE_MIGRATIONS` 数组（三子处）③ `version-map.ts` 的 `VERSION_MAP`。**外加**：④ parity 期望（`schema-dsl-*-parity.test.ts` 若有硬编码期望计数/列表）⑤ legacy fixture 两数组（parity 测比较的两份 RAW/SIMPLE fixture）⑥ `VERSION_MAP` range 断言。**Task 1/2 每条迁移都必须在同一 commit 内同步全 6 处 + 重建 schema-dsl dist**，不得留「CI 报再补」。号：Task 1 表迁移取 sqlite `v123`/postgres `v125`；Task 2 回填迁移取 sqlite `v124`/postgres `v126`（避开 server-raw v119-v122，与现有偏移一致）。
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
- Modify: parity fixture（见 Step 5 —— 先跑测试定位确切文件/数组，同 commit 补齐）
- Test: `src/test/unit/migrations.test.ts` + `src/test/integration/schema-dsl-{sqlite,pg}-parity.test.ts`

**Interfaces:**
- Produces: 表 `tenant_identity_directory`：`tenant_id TEXT NOT NULL`、`operation_id TEXT NOT NULL`、`lookup_kind TEXT NOT NULL CHECK IN ('email','refresh_token_hash','api_key_hash')`、`lookup_value TEXT NOT NULL`、`status TEXT NOT NULL CHECK IN ('PENDING','ACTIVE')`、`created_at INTEGER NOT NULL`、`updated_at INTEGER NOT NULL`。约束 `UNIQUE(lookup_kind, lookup_value)`（全局唯一→挡并发 register）；索引 `idx_tid_tenant (tenant_id)`。**无 shard_id 列**（shardId 由 tenantId 纯函数派生）。

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

- [ ] **Step 5: 重建 dist + 跑迁移测试，逐个补齐 parity 同步点**

Run: `npm run build --workspace=@wontlost-ltd/schema-dsl 2>&1 | tail -5`
Run: `npx tsx --test src/test/unit/migrations.test.ts src/test/integration/schema-dsl-sqlite-parity.test.ts src/test/integration/schema-dsl-pg-parity.test.ts 2>&1 | tail -30`
Expected: 全绿。**若报 missing/count-mismatch/fixture 不符** → 打开报错指向的文件（parity 期望数组 / legacy RAW/SIMPLE fixture 两数组 / VERSION_MAP range），在**本 commit 内**补齐（禁「留 CI 报再补」——这是 Global Constraints 硬约束）。反复跑到三测全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/schema-dsl/src packages/schema-dsl/dist src/test/integration/schema-dsl-*-parity.test.ts
git commit -m "feat(shard): coordinator tenant_identity_directory 表迁移(email/token/key→tenant + PENDING/ACTIVE，6 同步点全补)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `tenant_bootstrap` 标记表 + 历史数据回填迁移（向后兼容硬前置）

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-simple/v124.ts`（建 `tenant_bootstrap` 表 + 回填 directory）
- Modify: `index.ts`/`version-map.ts`/parity fixture（同 Task 1 全 6 同步点）
- Test: `src/test/integration/directory-backfill.test.ts`（新建）

**Interfaces:**
- Produces:
  - 表 `tenant_bootstrap`：`tenant_id TEXT NOT NULL PRIMARY KEY`、`operation_id TEXT NOT NULL`、`status TEXT NOT NULL CHECK IN ('COMPLETE')`、`created_at INTEGER NOT NULL`。（shard 内表；register 单事务写此行标记初始化完成。）
  - 回填 SQL（幂等）：把现有 `users.email → (tenant_id, 'email')`、`api_keys.key_hash → (tenant_id, 'api_key_hash')`、`refresh_tokens`（经 user 关联 tenant_id）→ `(tenant_id, 'refresh_token_hash')` 全部 `INSERT INTO tenant_identity_directory (... status='ACTIVE', operation_id='backfill') ON CONFLICT(lookup_kind,lookup_value) DO NOTHING`。**单库下**（升级路径）users/directory 同库，回填直接跑；多库下回填在部署工具按 shard 汇总到 coordinator（本迁移在单库/home 库内回填本库数据，多库汇总留部署脚本，标注 known-limitation）。

- [ ] **Step 1: 写回填迁移测（红）**

`directory-backfill.test.ts`：内存 sqlite 先跑到 v123（表存在、空），手插 3 个老 user（不同 email/tenant）+ 2 个 api_key + 1 个 refresh_token（无任何目录项，模拟升级前状态）→ 跑 v124 → 断言 directory 有对应 6 条 ACTIVE 项（email×3、api_key_hash×2、refresh_token_hash×1），operation_id='backfill'。再跑一次 v124（幂等）→ 无重复、无报错。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（v124 未建）。

- [ ] **Step 3: 写 v124.ts**

建 `tenant_bootstrap` 表 + 三条回填 `INSERT ... SELECT ... ON CONFLICT DO NOTHING`（SQLite/PG 两 renderer 都支持 `ON CONFLICT DO NOTHING`；照抄现有含 data-migration 的迁移写法，若 DSL 不支持 `INSERT SELECT` 则用 renderer raw SQL 段——先 Read 现有有数据回填的迁移确认 DSL 能力）。同步 index/version-map/parity（全 6 处）。重建 dist。

- [ ] **Step 4: 跑测试确认通过 + 迁移全门**

Run: `npm run build --workspace=@wontlost-ltd/schema-dsl 2>&1 | tail -5`
Run: `npx tsx --test src/test/integration/directory-backfill.test.ts src/test/unit/migrations.test.ts src/test/integration/schema-dsl-{sqlite,pg}-parity.test.ts 2>&1 | tail -30`
Expected: 全绿（含幂等）。

- [ ] **Step 5: Commit**

```bash
git add packages/schema-dsl/src packages/schema-dsl/dist src/test/integration/directory-backfill.test.ts src/test/integration/schema-dsl-*-parity.test.ts
git commit -m "feat(shard): tenant_bootstrap 标记表 + 历史 users/api_keys/refresh_tokens 回填 directory(ACTIVE)——老用户零中断

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
  - `dirCmdReserve({ tenantId, operationId, lookupKind, lookupValue, status, now })` → `INSERT INTO tenant_identity_directory (...) VALUES (...) ON CONFLICT(lookup_kind, lookup_value) DO NOTHING`（reserve 用 status='PENDING'；record token/key 用 'ACTIVE'）。
  - `dirCmdActivate({ operationId, lookupKind, lookupValue, now })` → `UPDATE ... SET status='ACTIVE', updated_at=? WHERE lookup_kind=? AND lookup_value=? AND operation_id=? AND status='PENDING'`（CAS；rowsAffected 判定）。
  - `dirQueryByLookup(lookupKind, lookupValue)` → `SELECT tenant_id, status, operation_id FROM tenant_identity_directory WHERE lookup_kind=? AND lookup_value=? LIMIT 1`。
  - `dirQueryPendingBefore(cutoff)` → `SELECT tenant_id, operation_id, lookup_kind, lookup_value FROM tenant_identity_directory WHERE status='PENDING' AND updated_at < ?`。
  - `dirCmdDeleteByLookup(lookupKind, lookupValue)` → `DELETE ... WHERE lookup_kind=? AND lookup_value=?`（撤销时清目录，尽力而为）。
  - `bootCmdMarkComplete({ tenantId, operationId, now })` → `INSERT INTO tenant_bootstrap (...) VALUES (... 'COMPLETE') ON CONFLICT(tenant_id) DO NOTHING`。
  - `bootQueryByTenant(tenantId)` → `SELECT tenant_id, operation_id, status FROM tenant_bootstrap WHERE tenant_id=? LIMIT 1`。

- [ ] **Step 1: 写 executor 单测（红）**

内存 sqlite + 迁移到 v124。测：reserve PENDING → `dirQueryByLookup` status=PENDING；**重复 reserve 同 lookup（ON CONFLICT DO NOTHING）→ 不报错、行不变、operation_id 仍第一次的**（幂等，非撞错）；`dirCmdActivate` 正确 operationId → rowsAffected=1、status=ACTIVE；**错 operationId activate → rowsAffected=0**（CAS 防他人激活）；已 ACTIVE 再 activate → 0；`bootCmdMarkComplete` 后 `bootQueryByTenant` status=COMPLETE、重复 mark 幂等；`dirCmdDeleteByLookup` 后查返 null。

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
  - `static deriveOperationId(lookupKind, lookupValue): string` — `'reg:' + sha256Hex(lookupKind + ':' + lookupValue)`（确定性；同 email 重试恒同值）。
  - `reserveTenant({ tenantId, email }): { operationId; reservedByUs: boolean }` — `dirCmdReserve` PENDING（ON CONFLICT DO NOTHING）后读回：若现存行 operationId===本次派生值且 tenantId===本次 → `reservedByUs:true`（含我们刚插的、或我们上次重试插的）；否则（他人已占 email）→ `reservedByUs:false`（调用方转 `AUTH_EMAIL_EXISTS`）。
  - `activateTenant({ email, operationId }): boolean` — CAS，rowsAffected===1。
  - `resolveByEmail(email): { tenantId; status } | null`。
  - `resolveByRefreshTokenHash(hash): { tenantId } | null` — 只在 ACTIVE 命中时返 tenantId，否则 null。
  - `resolveByApiKeyHash(hash): { tenantId } | null` — 同上。
  - `recordActiveLookup({ tenantId, lookupKind, lookupValue }): void` — 直接建 ACTIVE 目录项（token/key 由已 ACTIVE 租户签发，无两段）；ON CONFLICT DO NOTHING（尽力而为，冲突即已存在同映射）。
  - `removeLookup(lookupKind, lookupValue): void` — `dirCmdDeleteByLookup`（撤销时清，尽力而为；正确性靠 shard is_revoked 权威）。

- [ ] **Step 1: 门面单测（红）**

`FakeMultiShardResolver`（coordinator 独立 db）。断言：`reserveTenant` 写落 **coordinator db**（非 shard）；同 email 二次 reserveTenant（不同 tenantId）→ `reservedByUs:false`（他人已占）；**同 email 同 tenantId 重试 reserveTenant → `reservedByUs:true`**（确定性 opId 幂等，这是 Codex 关注的重入）；`resolveByEmail` PENDING 时返 status=PENDING；activate 后 ACTIVE；`resolveByRefreshTokenHash` 只在 ACTIVE 命中。

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
3. **CAS 失败不发 token**：stub activate 返 false → 断言不签发 token、抛可重试错误。
4. **并发/重复 register 同 email**：第二次 register(同 email, 新 tenantId) → `reservedByUs:false` → 抛 `AUTH_EMAIL_EXISTS`，不写第二 shard、不生第二 tenantId。
5. **确定性重试幂等**：模拟客户端超时重试——同 email 再 register，reserve 得 `reservedByUs:true`（同 opId），若 shard 已 COMPLETE 则直接 activate 收敛、发 token（不重建 user）。
6. **login 经目录**：register 后 login(email) → `resolveByEmail` ACTIVE → `dbForTenant` 验密码成功；PENDING 项 login → 拒。
7. **老用户兼容（Task 2 回填后）**：手插一个「回填」ACTIVE 目录项 + 对应 shard 的 user（模拟升级前用户）**不经 register** → login(email) 成功。这是 Codex 致命兼容项的回归锚。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL（ctor 裸 tx）。

- [ ] **Step 3: 改 register/login**

register 新序列（替换 `:65-102`）：
```
email 归一化；
const { operationId, reservedByUs } = directory.reserveTenant({ tenantId, email });
  // tenantId = `tenant_${randomUUID()}` 仅在首次；重试时 reserve 读回的既存行才是权威
if (!reservedByUs) throw AUTH_EMAIL_EXISTS;
const canonicalTenantId = <reserve 读回行的 tenant_id>;  // 幂等：重试用既存 tenantId
const tx = resolver.dbForTenant(canonicalTenantId);
tx 单事务内: 若 bootQueryByTenant 未 COMPLETE 才建 user/subscription/quota/identity(IdentityWriter) + bootCmdMarkComplete(canonicalTenantId, operationId);
             (COMPLETE 已存在=重试，跳过重建)
const activated = directory.activateTenant({ email, operationId });
if (!activated && resolveByEmail(email).status !== 'ACTIVE') throw AUTH_REGISTRATION_RETRY;  // CAS 失败且非已 ACTIVE→不发 token
generateTokenPair(...);
```
login（替换 `:104-117`）：`const entry = directory.resolveByEmail(email); if (!entry || entry.status !== 'ACTIVE') throw INVALID_CREDENTIALS; const tx = resolver.dbForTenant(entry.tenantId); const user = tx.queryOne(authQueryUserByEmail(email)); <argon2 verify + generateTokenPair(app, user.id, user.tenant_id, user.role)>`。
refresh（`:119-136`）：本 Task 只保证 ctor 改造后编译 + 不破单库（可暂用 user 表直查兜底），标注 `// Task 7: refresh_token_hash→tenant via directory`。

- [ ] **Step 4: 同步构造点** — `routes/auth.ts` `registerAuthRoutes(app, resolver, config)` + `new AuthService(resolver, config)`；`app.ts:753` 传 resolver。新错误码 `AUTH_REGISTRATION_RETRY` 注册进错误常量表（照抄 `AUTH_EMAIL_EXISTS` 位置）。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx tsx --test src/test/unit/auth-mixed-scope-sharding.test.ts src/test/integration/auth-api.test.ts 2>&1 | tail -25`
Expected: 全绿。**auth-api 回归特别确认**：单库下 register 多写目录/bootstrap 后，email 重复仍返 `AUTH_EMAIL_EXISTS`（错误码路径不变）；老用户 login（Step 1.7 若在集成层也建一条）通。

- [ ] **Step 6: Commit**

```bash
git add src/identity/auth-service.ts src/server/routes/auth.ts src/server/app.ts src/test/unit/auth-mixed-scope-sharding.test.ts
git commit -m "feat(shard): AuthService register 状态机(确定性 opId 幂等/bootstrap 标记/CAS 失败不发 token)+login 经目录+老用户兼容

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: SSO/OIDC + SCIM createUser 经目录定位

**Files:**
- Modify: `src/identity/sso-user-service.ts:28-95`、`src/server/routes/auth-sso.ts:95`、`src/server/routes/auth-oidc.ts:79`
- Modify: `src/enterprise/scim-provisioning-service.ts:70-142`、`src/server/app-services.ts:93`
- Test: `src/test/unit/auth-mixed-scope-sharding.test.ts`（追加）+ `stripe-auth-sso.test.ts`/`scim-compliance-evidence.test.ts` 回归

**Interfaces:**
- Consumes: `TenantIdentityDirectory`、`TenantDbResolver`、`IdentityWriter`、bootstrap 标记。
- Produces: `SsoUserService` ctor `(resolver)`；`ScimProvisioningService` ctor `(resolver, evidenceRecorder?, evidenceFailureSink?)`。签名/返回不变。

- [ ] **Step 1: SSO/SCIM 行为测（红）**

- `findOrCreateForSso`（自生成 tenant）：走 Task 5 同款 reservation 序列（reserve→shard 单事务写+bootstrap→CAS）。
- `findOrCreateForOidc(email, expectedTenantId)`：目录 email 已属**其他** tenant → 抛 `AUTH_SSO_FAILED`（从 coordinator 目录判定，非某 shard users 查）；一致则 `dbForTenant(expectedTenantId)` 建/取。
- SCIM `createUser(tenantId, {email})`：目录 email 属其他 tenant → 抛「已存在于其他 tenant」；新 email → reserve(email→tenantId)→`dbForTenant(tenantId)` 单事务写 user+identity+bootstrap（若该 tenant 首次）→ activate。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 改 SSO/SCIM**

- `sso-user-service.ts`：ctor `(resolver)` + `directory`；`identityWriter(tenantId)` → `new IdentityWriter(tenantId, this.resolver.dbForTenant(tenantId))`；`:47` 全局 email 查 → `directory.resolveByEmail`；`:50` 一致性对 `entry.tenantId`；`findOrCreateForSso` 自生成走 reservation。
- `scim-provisioning-service.ts`：ctor `(resolver, ...)`；`:117` 全局 email 查 → `directory.resolveByEmail`；写走 `dbForTenant(tenantId)` 单事务 + bootstrap。
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

`FakeMultiShardResolver`。造两 PENDING：A 的 shard 有 `tenant_bootstrap` COMPLETE（模拟 shard 写成功 CAS 丢）；B 的 shard **无** bootstrap 行（模拟未提交/半初始化，即使手插一条 user 行也不算完成）。`reconcile()` → A→ACTIVE（activated=1）；B **仍 PENDING**（retained=1，未删）。断言 B 目录项 reconcile 后仍在（`resolveByEmail` 返 PENDING 非 null）——spec §4.1.6 防孤儿核心。再断言：B 即使有 user 行但无 bootstrap COMPLETE → 仍 retained（不误激活半初始化，Codex #3）。

- [ ] **Step 2: 跑测试确认失败** — Expected FAIL。

- [ ] **Step 3: 写 `TenantReservationRecovery` + `listPending`**

```
reconcile(now):
  for pending of directory.listPending(now - GRACE):
    const boot = resolver.dbForTenant(pending.tenantId).queryOne(bootQueryByTenant(pending.tenantId));
    if (boot?.status === 'COMPLETE') { directory.activateTenant({ email: pending.lookupValue, operationId: pending.operationId }); activated++; }
    else { logger.warn('reservation retained: shard bootstrap not COMPLETE', { tenantId: pending.tenantId }); retained++; }  // 绝不取消
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
- **Placeholder 扫描**：DSL builder API 标「以 v078/v108 为准」（防自创非 placeholder）；parity fixture「打开报错文件补齐」是确定动作非 TBD。
- **类型一致**：`reserveTenant` 返 `{operationId, reservedByUs}`、`activateTenant` 返 boolean、`resolveBy*` 返 `{tenantId(,status)}|null`、`recordActiveLookup`/`removeLookup`/`changeEmailLookup`/`listPending` 全 Task 引用一致；`bootCmdMarkComplete`/`bootQueryByTenant` 一致；`AUTH_REGISTRATION_RETRY` 新错误码在 Task 5 注册。
- **复杂度**：目录门面方法均单一职责、≤3 层缩进；三类 lookup 合表靠 `lookup_kind` 判别（非三表），概念集中。恢复 worker reconcile 单循环。
- **向后兼容/破坏性**：回填迁移保证零中断；单库 coordinatorDb≡dbForTenant 等价现状；错误码路径（AUTH_EMAIL_EXISTS）保持。
