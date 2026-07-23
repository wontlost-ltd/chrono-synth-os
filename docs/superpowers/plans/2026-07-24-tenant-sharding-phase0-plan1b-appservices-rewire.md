# 分片 Phase 0 · Plan 1b：buildAppServices tenant-scoped 服务 rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。步骤用 checkbox（`- [ ]`）追踪。
> 第 3 轮修订（采纳 Codex 77 退回 3 阻断）：IdentityWriter(tenantId,tx) 真绑定(方法不再接 tenantId,消双源)+每组产自己操作矩阵(Avatar JOIN/写前验二选一钉死/DeviceAvatar 两端验)+PushDispatcher 全传播链(dispatcher/types/invalidation 回调带 tenantId)+两 mutation 钉死(换 home 选非 home 租户/删 predicate 种 B 键用 A 查)+mixed 逐 edge 非整体升级。前轮 68 退。
> Codex 分类裁决（见 spec 关联）：15 个 buildAppServices 成员按「调用前是否已知 tenantId」分类——JWT 带 tenantId 故已认证路径不需 userId→shard directory，穿 tenantId 进方法 + `(tenantId, key)` 查即可。本 Plan 只做**纯 tenant-scoped** 那批；mixed-scope/coordinator（Auth/UserProfile-email/SCIM-createUser/API-key-hash）归 Plan 1c；ConfigService platform 单列。

**Goal:** 把 tenant-scoped 长期 service（Identity/Avatar/Collaboration/MobileDevice+Facade/Organization/AdminControlPlane/KnowledgeSource/ApiKey-mgmt/TenantEnterpriseProfile-tenant-methods）从「ctor 固定 host db」rewire 为「持 `TenantDbResolver`，方法接 tenantId，`resolver.dbForTenant(tenantId)` + SQL tenant predicate 双重约束」。删 `AppServices.db` 裸 host db 字段 + 未用 carrier + RBAC preHandler 改 resolver。**仍 fail-closed 挡多库**（Plan 1 guard 未放开）。

**Architecture（含 tenant-bound seam——Codex 退回 #1/#2 核心）：**
- **tenant-bound seam**：每个被 mixed-scope（Plan 1c 的 Auth/SCIM/SSO）复用的 service（尤 IdentityService）抽出 **tenant-bound 内核**（如 `IdentityWriter`/`IdentityRepository`，ctor 收**已解析的 tx**）。长期 `IdentityService` ctor 收 `resolver`，方法 `dbForTenant(tenantId)` 得 tx 后委托内核。Plan 1c 的 coordinator 定位 tenant 后**用同一 tenant-bound 内核**（传它解析出的 tx）——**不破坏、不半截、不 `new SingleDbResolver(this.tx)` 过渡回退**。
- service ctor 从 `(tx)` 改 `(resolver: TenantDbResolver)`；每 tenant-scoped public 方法首参加 `tenantId`，内 `const tx = this.resolver.dbForTenant(tenantId)`。
- **SQL tenant predicate（在 query helper 层——`packages/kernel/**/*-queries.ts` + executors）**：有 tenant_id 列的表 `WHERE tenant_id=? AND <key>=?`；**无 tenant_id 列的（avatars/device_avatars 只有 identity_id）用 `JOIN identities WHERE identities.tenant_id=?` 或 EXISTS 父归属**。**诚实（Codex #3）**：predicate 只防**同 shard 内**跨租户读改删；错-resolver-映射（A 映射到 B shard 仍写成功）由 ShardRouter 映射测试保证，**非本 predicate**。
- route 从 JWT `request.user.tenantId` 取 tenantId 传方法。构造点全改传共享 resolver（内部 sso-user/build-dispatcher/nudge-push 见 Task 内逐项定死，非「有就改」）。

**Tech Stack:** Node.js + TypeScript。复用 Plan 1 的共享 `resolver`（app.ts createApp 已建、穿进）+ `TenantDbResolver`/`SingleDbResolver`。测试 `src/test/unit/` + `FakeMultiShardResolver`。

## Global Constraints

1. **隔离双重约束（+ 诚实边界，Codex #3）**：per-tenant 方法 = `dbForTenant(tenantId)`（选 shard）+ SQL tenant predicate（有 tenant_id 列直加，无列的经 JOIN identities/EXISTS 父归属）。**predicate 只防同 shard 内跨租户读改删**；错-resolver-映射（写对了 tenant_id 但落错 shard）由 ShardRouter 映射测试保证，本 predicate 管不了——故测试拆**两独立 mutation**：① `dbForTenant` 换 home DB → 2-shard 测红（证选对 shard）；② 删 tenant predicate + A/B 用相同业务 ID 共享物理 db → 测红（证 predicate 防同库跨租户）。
2. **单库零回归**：`resolver.dbForTenant(t)` 单库返同一 db；加 tenant predicate 后单库查询结果不变（本就同租户）。现有全测试绿是硬门。
3. **验收门 = Plan 0 AST edge 门为主（Codex #「rg 不可靠」）**：`check:db-access`（Plan 0 evaluateGate）是主门——rewire 后 tenant-scoped service 的 carrier edge disposition→resolver、provenance→resolved、wiringStatus→wired（2-shard 测覆盖→verified）；例外逐 edge inventory 分类。`rg --glob '!src/test/**' 'new (...)Service\('` 仅机械辅助（它看不出传的是 resolver 还是 db，故非主门）。构造点须含 `TenantEnterpriseProfileService`/`MobileDeviceFacade`/`DeviceAvatarService`/`AvatarAutorunFacade` 等容器外点。
4. **删 `AppServices.db`**：裸 host db 字段是错-shard 逃生口——删；RBAC preHandler（organizations.ts）改用 resolver。删未用 carrier（route 各自构造的 avatar/config 等死成员）。
5. **不碰 mixed-scope（Plan 1c）**：Auth/UserProfile.updateEmail/SCIM.createUser/API-key-hash 反查/refresh-token/OIDC 用户创建不在本 Plan——本 Plan 只 tenant-scoped 方法。
6. **db-capability 门同步**：改完 `check:db-access` 按真实归因更新 inventory（tenant-scoped service 现真接 resolver → disposition resolver + wiringStatus `wired`，被 2-shard 行为测覆盖的 → `verified`）。不放宽门。
7. **中文注释**；`test:golden` 全绿。测试位置 `src/test/unit/`。

---

## File Structure

- `src/identity/{identity,avatar,collaboration,mobile-device}-service.ts` + `mobile-device-facade.ts` — ctor 改 resolver，方法加 tenantId + tenant predicate。
- `src/enterprise/{organization,admin-control-plane}-service.ts` + `tenant-enterprise-profile-service.ts`（仅 tenant 方法）— 同。
- `src/knowledge/knowledge-source-service.ts` + `src/billing/api-key-service.ts`（仅管理方法）— 同。
- `src/server/app-services.ts` — 成员传 resolver；删 `db` 字段 + 未用 carrier。
- route（identity/avatars/organizations/mobile/... + 内部 sso-user-service/build-dispatcher/nudge-push-bridge/privacy）— 构造/调用点传 resolver + tenantId。
- Test: `src/test/unit/appservices-tenant-scoped-sharding.test.ts`。

---

## Task 分解（按**依赖分组**，非机械单 service——Codex #「Avatar/Mobile 不是简单单 service」）

> IdentityService 为**范式 task**（含 tenant-bound seam 详列）；其余按依赖分组（Avatar 组含 DeviceAvatar/Autorun/Identity-ownership；Mobile 组含 Facade/DeviceLookup；TenantEnterpriseProfile 先拆 ScimTenantDirectory）。每 task 结构同范式但**各列自己的操作矩阵 + query/executor 文件**（不「同构」带过——各 service 的表/predicate/JOIN 不同）。

## Task 1: `IdentityService` rewire + tenant-bound seam（范式 + 供 Plan 1c 复用）

**Files:** Modify `src/identity/identity-service.ts`（+ 抽 tenant-bound seam）+ `packages/kernel/src/domain/identity/identity-queries.ts`（query 加 tenant predicate：`identQueryByUser(userId)`→`identQueryByTenantAndUser(tenantId, userId)` 等）+ `src/storage/executors/identity-executors.ts`（参数含 tenantId）+ **全构造点**（`app-services.ts`/`avatars.ts`/`sso-user-service.ts`/`auth-service.ts:96`/`scim-provisioning-service.ts:124`）+ route（identity.ts 传 `request.user.tenantId`）；Test `src/test/unit/appservices-tenant-scoped-sharding.test.ts`

**Interfaces（真 tenant-bound seam——Codex 第 2 轮 #1：tenantId+tx 同一构造绑定，非两独立输入）：**
```typescript
class IdentityWriter {
  constructor(private readonly tenantId: string, private readonly tx: SyncWriteUnitOfWork) {}
  getByUser(userId: string) { return this.tx.queryOne(identQueryByTenantAndUser(this.tenantId, userId)); }
  // 方法**不再接 tenantId**（消双源不一致）；tenantId 恒来自构造时绑定
}
```
- 长期 `IdentityService` ctor 收 `resolver`，`private writerFor(tenantId) { return new IdentityWriter(tenantId, this.resolver.dbForTenant(tenantId)); }`；方法 `getByUser(tenantId, userId) = this.writerFor(tenantId).getByUser(userId)`。**writer 不跨请求缓存**（避免无界 tenant cache）。
- **Plan 1c 的 Auth/SCIM/SSO 定位 tenant 后用 `new IdentityWriter(resolvedTenantId, resolvedTx)`**（同一 tenantId 同时建 writer）——本 Plan 把它们的 `new IdentityService(tx)` 改为经 writer seam；**依赖接线本 Plan 做**（不留编译坏路径、不 `new SingleDbResolver(this.tx)` 回退、不暴露不带 tenantId 的 `writer(tx)` 工厂）。ApiKey tenant-bound seam 同理（`ApiKeyWriter(tenantId, tx)`）。
- **每个 `new IdentityWriter(...)` 是 Plan 0 inventory 里独立的 resolved-tx sink edge**，逐调用点审计（非函数整体升级）。

**操作矩阵（read/write/update/delete + query 文件——Codex #4，不「同构」带过）：**
| 操作 | 方法 | query helper（现→改） | 表/predicate |
|---|---|---|---|
| read | getByUser | `identQueryByUser(userId)` → `identQueryByTenantAndUser(tenantId,userId)` | identities WHERE tenant_id=? AND user_id=? |
| read | listByTenant | `identQueryByTenant(tenantId)`（已 tenant-scoped） | identities WHERE tenant_id=? |
| create | create/ensureForUser | `identCmdCreate` 参数已含 tenant_id（v-迁移列） | identities |
| update | update | `identCmdUpdate({identityId})` → 加 tenantId 校验（更新前 EXISTS tenant 归属 或 WHERE id=? AND tenant_id=?） | identities |

- [ ] **Step 1: 写 2-shard 行为失败测试**

```typescript
// src/test/unit/appservices-tenant-scoped-sharding.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityService } from '../../identity/identity-service.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SqliteDatabase } from '../../storage/database.js';

test('IdentityService per-tenant：A 的 identity 落 A 的 shard，B 的 shard 查不到（选对 shard + tenant predicate）', () => {
  const s0 = new SqliteDatabase(':memory:'); const s1 = new SqliteDatabase(':memory:'); const coord = new SqliteDatabase(':memory:');
  // 三库跑迁移（照既有建库惯例）
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new IdentityService(resolver);
  svc.create('tA', 'userA', 'Alice');   // 应落 s0
  assert.ok(svc.getByUser('tA', 'userA'));                     // A 在自己 shard 查得到
  assert.equal(svc.getByUser('tB', 'userA'), null);            // 用 tB（→s1）查 userA：查不到（不串 shard）
  s0.close(); s1.close(); coord.close();
});
```

- [ ] **Step 2: 运行确认失败**（IdentityService 还是 `(tx)` ctor + 方法无 tenantId → 编译红 or 行为红）

- [ ] **Step 3: rewire IdentityService**：ctor 收 resolver；每方法首参 tenantId，内 `const tx = this.resolver.dbForTenant(tenantId)`；**SQL 加 `AND tenant_id=?`**（getByUser 从 `WHERE user_id=?` 改 `WHERE tenant_id=? AND user_id=?`）。更新构造点（app-services.ts `new IdentityService(resolver)`、avatars.ts、sso-user-service.ts）+ identity route 传 `request.user.tenantId`。

- [ ] **Step 4: 运行确认通过 + typecheck**（2-shard 行为绿；`npm run typecheck` 捕获所有漏改调用点——方法加 tenantId 参是编译期破坏，逐个补）

- [ ] **Step 5: 两独立变异自证（Codex 第 2 轮 #4——非静态字符串断言）**：
  - **mutation ① 换 home DB**：租户 B 映射 s1、home=s0；把 `dbForTenant(tenantId)` 换成恒 home（s0）→ 断言「B 的 identity 写入 s1、s0 无」的 2-shard 测**红**（证选对 shard）。**须选真映射到非 home 的租户**（A 本在 home 时换 home 不红）。
  - **mutation ② 删 tenant predicate**：**共享物理 db**，只种租户 B 的业务键 X（如 identity userId=X 属 tenantId=tB），用 **tenantId=tA + X** 查/改/删 → 有 predicate 时无结果（正确），删 predicate 后错误命中 B 的行 → 测**红**（证 predicate 防同库跨租户）。**不用「A/B 同主键 insert」**（有唯一约束会先撞）。
  - **不写「断言 predicate 在 SQL」静态字符串**（Codex：静态断言不替代行为测）。还原后复绿。

- [ ] **Step 6: Commit** — `feat(shard): IdentityService per-tenant rewire（resolver+方法 tenantId+SQL tenant predicate 双重约束）`（Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>）

## Task 2-8: 同构 rewire（按依赖分组，非机械单 service——Codex #「Task 拆分」）

每组照 Task 1 范式（ctor 收 resolver + writer seam + query 层 tenant predicate + 全构造点 + route 传 tenantId + 2-shard 行为测 + 两 mutation 自证 + commit）。**每组 task 实现前须先产出自己的操作矩阵**（read/write/update/delete × 现 helper→新 helper × tenant 约束 × executor 文件 × 变异用例），非套 Identity 的（各 service 表/predicate/JOIN 不同）。下列把**不能留给实现者二选一的决策**逐组钉死：

- **Task 2 Avatar 组**（AvatarService + DeviceAvatarService + AvatarAutorunFacade）：avatars/device_avatars **无 tenant_id 列**（只 identity_id，v027）。**钉死（非「JOIN 或验证」二选一）**：read = tenant-qualified `JOIN identities WHERE identities.tenant_id=?`；create = **同一 tx 内先验 identity 属 tenant（`EXISTS identities WHERE id=? AND tenant_id=?`）再 INSERT**；update/delete = `WHERE identity_id IN (SELECT id FROM identities WHERE tenant_id=?)` 或 EXISTS 父归属；DeviceAvatar = device 端 + avatar 端**两端**都验 tenant 归属。构造点含 `avatars.ts`/`app.ts:queueTx AvatarService`（queue/worker shard 决策 → 标 Plan 3 不误 verified）。
- **Task 3 Mobile 组**（MobileDeviceService + MobileDeviceFacade + **PushDispatcher 全传播链**）：device 表有 tenant_id。**PushDispatcher 全链改 `(tenantId, deviceId)`（Codex 第 2 轮 #3——非只 lookup）**：改 `src/agent/push/dispatcher.ts`（`send()` 现丢弃 `_tenantId` → 用它；`sendBatch()`）+ `src/types/push.ts`（`DeviceLookup`/`TokenInvalidationCallback` 类型加 tenantId）+ `src/agent/push/build-dispatcher.ts`（构造接 resolver）+ provider 测试夹具。**invalidation 回调也带原 tenantId**（`fireAndForgetInvalidation(tenantId, deviceId, reason)`），非只 lookup。MobileDeviceFacade 已收 JwtPayload 一次调用解析一次 tx 内部 helper 共用。
- **Task 4 OrganizationService**：方法已普遍带 tenantId → 改 resolver dbForTenant 即可（改动最小）。
- **Task 5 AdminControlPlaneService**：名字像平台但查询全按 tenantId（租户管理面）→ per-tenant。
- **Task 6 KnowledgeSourceService**：public 方法已有 tenantId → resolver 化。
- **Task 7 TenantEnterpriseProfileService 拆分**（Codex #1）：**先拆** `resolveScimTenant(token)`/`storeScimToken` 到 `ScimTenantDirectory`（token→tenant，单库暂接 `coordinatorDb()`，inventory 保持 planned，真目录一致性归 Plan 1c）；`TenantEnterpriseProfileService` 只留已知 tenantId 的 profile/OIDC/KMS 方法 → resolver。**避免 ctor resolver 化但 pre-tenant 方法假全局的半成品**。
- **Task 8 UserProfileService 部分 rewire + ApiKeyService 管理方法**（Codex #3）：UserProfile `getProfile/changePassword`（tenant-scoped，route 在用）本 Plan resolver 化；`updateEmail` 抽到 `UserEmailDirectoryService`/coordinator port 归 Plan 1c。ApiKeyService create/list/revoke（按 tenantId）本 Plan；key hash→tenant 反查归 Plan 1c（同样抽 tenant-bound seam 供 1c 用）。

## Task 9: 删 `AppServices.db` + 未用 carrier + RBAC preHandler 改 resolver

**Files:** Modify `src/server/app-services.ts`（删 `db` 字段 + 死 carrier）+ `src/server/routes/organizations.ts`（RBAC preHandler 用 resolver）+ 各处引用 `services.db` 的点。

> **mixed 过渡状态诚实（Codex 第 2 轮 #3）**：Plan 1b 后 Auth/SCIM/SSO 仍在单库 fail-closed 下经 writer seam 用现有 tx（架构可接受）；但 inventory **逐 edge 更新非函数整体升级**——`buildAppServices` 里 mixed 成员（Auth/UserProfile.updateEmail/SCIM.createUser/API-key-hash）的 edge 保持 `planned`，只 tenant-scoped 成员 edge 升 `wired`/`verified`。`ScimProvisioningService` 的 evidence recorder（`recordEvidence(db,...)`）db 来源明确标注（coordinator/planned）。**绝不因删了 `AppServices.db` 字段/部分成员 resolver 化就把整个 buildAppServices carrier 标 wired**。

- [ ] **Step 1: 写失败测试**（`AppServices` 类型无 `db` 字段——引用 `services.db` 编译红；RBAC preHandler per-tenant）
- [ ] **Step 2-4: 删 db 字段 + 删未用 carrier（route 各自构造的死成员，`rg services.<member>` 零引用的）+ RBAC preHandler 从 `services.db` 改 `resolver.dbForTenant(request.user.tenantId)`；typecheck 捕获所有 `services.db` 引用逐个改**
- [ ] **Step 5: Commit** — `feat(shard): 删 AppServices.db 裸 host db 逃生口 + 未用 carrier + RBAC preHandler resolver 化`

## Task 10: 内部构造点（逐项定死）+ 验收门 + db-capability 同步

**内部构造点处置（Codex #「占位决策」——逐项定死非「有就改」）：**
- `src/server/services/nudge-push-bridge.ts`：事件**已有 tenantId**（`deliver(tenantId,...)`）→ 本 Plan resolver 化（`new MobileDeviceService(resolver)` + 传 tenantId）。
- `src/agent/push/build-dispatcher.ts`：`DeviceLookup` 回调仅 deviceId 无 tenantId → **契约改 `(tenantId, deviceId)`**（Task 3 已做，本 Task 确认构造点接 resolver）。
- `src/identity/sso-user-service.ts`：mixed-scope（SSO 用户创建）→ **归 Plan 1c**，但本 Plan 把它对 `IdentityWriter` 的依赖接好（seam），不留编译坏路径。
- `src/privacy/privacy-service.ts`：方法已有 tenantId → resolver 化（TenantEnterpriseProfileService 依赖按 Task 7 拆分后的边界）。
- `app.ts` queue/avatar 构造：queue/worker shard 决策 → **标 Plan 3，不误标 verified**。

- [ ] **Step 1: 验收门测**（主门 `check:db-access` Plan 0 evaluateGate + 辅 `rg --glob '!src/test/**' 'new (...)Service\('`——tenant-scoped 全经 resolver；Auth/SCIM/SSO/API-key-hash 例外 inventory 标 mixed-scope planned 归 Plan 1c）
- [ ] **Step 2: 改内部构造点**（按上逐项）
- [ ] **Step 3: db-capability 门同步**：`check:db-access` → tenant-scoped edge disposition→resolver + wiringStatus→`wired`（2-shard 测覆盖→`verified`）；mixed-scope/Plan3 项保持 planned；不放宽门
- [ ] **Step 4: Commit** — `feat(shard): 内部构造点 resolver 化（逐项定死）+ 验收门 + inventory 同步`

---

## 收尾

- [ ] `npm run test:golden` EXIT 0（单库零回归 + check:db-access 门同步）。
- [ ] `rg 'new (Identity|Avatar|MobileDevice|Organization|Collaboration|AdminControlPlane|KnowledgeSource)Service\(' src`（非 test）全经 resolver（Plan 1c 的 Auth/SCIM 例外除外）。
- [ ] 最终整片 code review（重点核：tenant-scoped service 真双重约束（shard + predicate）、无 `AppServices.db` 残留、单库零回归、mixed-scope 未误动）。

## Self-Review（writing-plans 自检）

**Spec 覆盖**：spec §3-A buildAppServices ~15 成员 → Codex 分类：本 Plan 做纯 tenant-scoped（Identity/Avatar/Collaboration/MobileDevice+Facade/Organization/AdminControlPlane/KnowledgeSource/TenantEnterpriseProfile-tenant/ApiKey-mgmt）+ 删 AppServices.db + RBAC；mixed-scope（Auth/UserProfile-email/SCIM-createUser/API-key-hash）→ Plan 1c；ConfigService platform 单列。

**关键设计（Codex 裁决）**：① JWT 带 tenantId 故 per-tenant 方法穿 tenantId 参（非 userId→shard directory）；② 隔离双重约束（dbForTenant 选 shard + SQL tenant predicate）；③ rewire 形态 (a) service 持 resolver 方法接 tenantId（非 route 每请求 new——避免后台任务/内部调用绕过、审计面散）；④ 验收门覆盖全构造点非只 buildAppServices。

**边界**：仍 fail-closed 挡多库（Plan 1 guard）；本 Plan 只 tenant-scoped，mixed-scope 明确留 Plan 1c 避免多个「全局 email 真源」不一致。单库零回归靠 typecheck 捕获方法签名破坏的全调用点 + tenant predicate 单库无差别。

**已知实现点**：各 service 真实方法签名/SQL query 模块（tenant predicate 加在 query helper 层）；route 从 `request.user.tenantId` 取；内部构造点（sso-user/build-dispatcher/nudge-push）的 tenantId 上下文有无（无则标后续 Plan）。
