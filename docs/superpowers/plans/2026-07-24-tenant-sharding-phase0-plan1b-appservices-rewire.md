# 分片 Phase 0 · Plan 1b：buildAppServices tenant-scoped 服务 rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。步骤用 checkbox（`- [ ]`）追踪。
> Codex 分类裁决（见 spec 关联）：15 个 buildAppServices 成员按「调用前是否已知 tenantId」分类——JWT 带 tenantId 故已认证路径不需 userId→shard directory，穿 tenantId 进方法 + `(tenantId, key)` 查即可。本 Plan 只做**纯 tenant-scoped** 那批；mixed-scope/coordinator（Auth/UserProfile-email/SCIM-createUser/API-key-hash）归 Plan 1c；ConfigService platform 单列。

**Goal:** 把 tenant-scoped 长期 service（Identity/Avatar/Collaboration/MobileDevice+Facade/Organization/AdminControlPlane/KnowledgeSource/ApiKey-mgmt/TenantEnterpriseProfile-tenant-methods）从「ctor 固定 host db」rewire 为「持 `TenantDbResolver`，方法接 tenantId，`resolver.dbForTenant(tenantId)` + SQL tenant predicate 双重约束」。删 `AppServices.db` 裸 host db 字段 + 未用 carrier + RBAC preHandler 改 resolver。**仍 fail-closed 挡多库**（Plan 1 guard 未放开）。

**Architecture:** service ctor 从 `(tx: SyncWriteUnitOfWork)` 改 `(resolver: TenantDbResolver)`；每 public 方法首参加 `tenantId: string`，内部 `const tx = this.resolver.dbForTenant(tenantId)`；**SQL 同时加 tenant predicate**（`WHERE tenant_id=? AND <key>=?`——不只选对 shard，防错 resolver 映射/ID 碰撞跨租户读写，隔离双重约束）。route 从 JWT `request.user.tenantId` 取 tenantId 传进方法。所有构造点（app-services.ts + routes + 内部 sso-user/build-dispatcher/nudge-push/privacy）改传共享 resolver。

**Tech Stack:** Node.js + TypeScript。复用 Plan 1 的共享 `resolver`（app.ts createApp 已建、穿进）+ `TenantDbResolver`/`SingleDbResolver`。测试 `src/test/unit/` + `FakeMultiShardResolver`。

## Global Constraints

1. **隔离双重约束**：per-tenant service 方法 = `resolver.dbForTenant(tenantId)`（选对 shard）**+ SQL `WHERE tenant_id=?`**（tenant predicate）。仅选对 shard 不够（错映射/ID 碰撞会跨租户）——两者都要（Codex）。
2. **单库零回归**：`resolver.dbForTenant(t)` 单库返同一 db；加 tenant predicate 后单库查询结果不变（本就同租户）。现有全测试绿是硬门。
3. **验收门覆盖全构造点（非只 buildAppServices）**：`rg 'new (Identity|Avatar|MobileDevice|Organization|Collaboration|AdminControlPlane|KnowledgeSource|ApiKey)Service\(' src`（非 test）→ 全部经共享 resolver 或明确分类（内部 sso-user/build-dispatcher/nudge-push 也改）。
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

## Task 分解（按 service 分批——每 service 独立可测可 review）

> 每个 service 一个 task（rewire + 构造点更新 + 2-shard 行为测）。以 IdentityService 为**范式 task**详列；其余 service 同构（Task 结构相同，只换 service/方法/表/key）。

## Task 1: `IdentityService` rewire（范式）

**Files:** Modify `src/identity/identity-service.ts` + 构造点（`app-services.ts`/`avatars.ts`/`sso-user-service.ts`）+ route（identity.ts 传 tenantId）；Test `src/test/unit/appservices-tenant-scoped-sharding.test.ts`

**Interfaces:**
- ctor `(resolver: TenantDbResolver)`（原 `(tx)`）；方法加 tenantId：`getByUser(tenantId, userId)` / `update(tenantId, identityId, data)` / `ensureForUser(tenantId, userId, displayName)` / `create(tenantId, userId, displayName)` / `listByTenant(tenantId)`（已有）。

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

- [ ] **Step 5: 变异自证**：把 SQL 的 `AND tenant_id=?` 去掉（只选对 shard 不加 predicate）→ 构造「A、B 同 userId 但不同 shard，且测试用单库 fake（s0==s1）」场景应能抓（或断言 predicate 在 SQL）。或把 dbForTenant 换成恒 home → 串 shard 测红。还原。

- [ ] **Step 6: Commit** — `feat(shard): IdentityService per-tenant rewire（resolver+方法 tenantId+SQL tenant predicate 双重约束）`（Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>）

## Task 2-8: 同构 rewire（AvatarService / CollaborationService / MobileDeviceService+Facade / OrganizationService / AdminControlPlaneService / KnowledgeSourceService / TenantEnterpriseProfileService-tenant-methods / ApiKeyService-mgmt-methods）

每个照 Task 1 范式：ctor 收 resolver + 方法加 tenantId + SQL tenant predicate + 更新构造点 + route 传 tenantId + 2-shard 行为测 + 变异自证 + commit。
- **AvatarService**：avatars 经 identity 归租户（`INNER JOIN identities WHERE tenant_id=?`）。
- **MobileDeviceFacade**：已收 JwtPayload（有 tenantId）——一次调用解析一次 tenant db，内部 device/identity helper 共用。
- **OrganizationService**：方法已普遍带 tenantId，改 resolver 后 dbForTenant 即可（改动最小）。
- **AdminControlPlaneService**：名字像平台但查询全按 tenantId（租户管理面）→ per-tenant。
- **TenantEnterpriseProfileService**：**仅 tenant 方法**（profile/OIDC config get）本 Plan；`resolveScimTenant(token)` token→tenant 定位归 Plan 1c。
- **ApiKeyService**：**仅管理方法**（create/list/revoke 按 tenantId）本 Plan；key hash→tenant 反查归 Plan 1c。

## Task 9: 删 `AppServices.db` + 未用 carrier + RBAC preHandler 改 resolver

**Files:** Modify `src/server/app-services.ts`（删 `db` 字段 + 死 carrier）+ `src/server/routes/organizations.ts`（RBAC preHandler 用 resolver）+ 各处引用 `services.db` 的点。

- [ ] **Step 1: 写失败测试**（`AppServices` 类型无 `db` 字段——引用 `services.db` 编译红；RBAC preHandler per-tenant）
- [ ] **Step 2-4: 删 db 字段 + 删未用 carrier（route 各自构造的死成员，`rg services.<member>` 零引用的）+ RBAC preHandler 从 `services.db` 改 `resolver.dbForTenant(request.user.tenantId)`；typecheck 捕获所有 `services.db` 引用逐个改**
- [ ] **Step 5: Commit** — `feat(shard): 删 AppServices.db 裸 host db 逃生口 + 未用 carrier + RBAC preHandler resolver 化`

## Task 10: 内部构造点 + 验收门 + db-capability 同步

**Files:** `src/identity/sso-user-service.ts` / `src/agent/push/build-dispatcher.ts` / `src/server/services/nudge-push-bridge.ts` / `src/privacy/privacy-service.ts` 的 `new XxxService(...)` 构造点改传 resolver（若这些点已有 tenantId 上下文；无则标 Plan 1c/2）；inventory 同步。

- [ ] **Step 1: 验收门测**（`rg 'new (Identity|Avatar|MobileDevice|Organization|Collaboration|AdminControlPlane|KnowledgeSource)Service\(' src`（非 test）→ 全部经共享 resolver；例外须 inventory 明确分类）
- [ ] **Step 2: 改内部构造点**（sso-user-service/build-dispatcher/nudge-push——若有 tenantId 上下文改 resolver+tenantId；nudge-push-bridge 是 §5 terminal-escape 若无 tenantId 归 Plan 2 标注）
- [ ] **Step 3: db-capability 门同步**：`check:db-access` → tenant-scoped service edge disposition→resolver + wiringStatus→`wired`（2-shard 测覆盖的→`verified`）；不放宽门
- [ ] **Step 4: Commit** — `feat(shard): 内部构造点 resolver 化 + 验收门 + inventory 同步（tenant-scoped 全 wired/verified）`

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
