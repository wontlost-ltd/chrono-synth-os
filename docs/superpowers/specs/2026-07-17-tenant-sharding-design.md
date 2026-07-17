# 租户分片设计（application-level tenant→shard routing）

**日期:** 2026-07-17
**范围:** `src/storage/`（factory + shard router）、`src/multi-tenant/`（tenant-os-factory 路由点）、`src/config/schema.ts`（shard map 配置）、`src/server/routes/metrics.ts` + `src/observability/`（fan-out）、`src/privacy/`（迁移复用）、协调库 schema
**关联:** 规模化缺口 #3；依赖 #4（编译锁去全局化，PR #312）——分片后每 shard 内部仍需 per-persona 锁才不被大租户串行卡死
**状态:** 多阶段**设计总览**（Phase 0-3 的架构 + 接口契约 + 依赖顺序）。**本文件不直接可实现**——每个 Phase 落地前须各自出一份详细 spec + plan（本总览定契约与边界，细节在各 Phase spec）。Phase 0 优先。

## 背景与问题

当前所有租户共享**一个** Postgres 实例：`createDatabase(config)`（`storage/factory.ts:13`）建单个 `PostgresDatabase`（单 `pg.Pool`，`postgres-database.ts:197`），`TenantOSFactory` 把它包进 `TenantDatabase(this.db, tenantId)`（`tenant-os-factory.ts:111`）注入 `WHERE tenant_id = ?`。单实例撑不到 6e9 persona 的行数/连接规模，`tenantId` 逻辑上是天然分片键却只当 WHERE 过滤用。

**好消息（已核实）：** 分片的注入点极干净——`tenantId` 在 `server/plugins/tenant.ts` 单点解析，DB 访问全经 `TenantDatabase(db, tenantId)` 单一包装，`IDatabase` 是**同步接口**（`prepare/exec/transaction/close`，无 async）。所以路由可以在 `TenantOSFactory` 层同步解析 shard 一次，不改任何业务代码/SQL。

**坏消息（agent 深掘出的三个硬问题）：**
1. **`default` 租户结构上不可分片**：20+ 路由硬编码 `tid !== 'default' → tenantFactory；否则 → 裸 host os`（`memory-facade.ts:108`、`companion/chat.ts:112`、`operations.ts:18` 等）。`default` 绕过 `TenantOSFactory`、直接绑 host DB，且它是所有未认证/companion 用户的共享桶（最热租户），却是唯一结构上挪不动的租户。
2. **跨租户聚合要 fan-out**：`/metrics` 用裸 `os.getDatabase()` 跨所有租户读（population diversity O(n²) 全量 `decision_style`、rollup SUM、tenant usage），分片后只见本 shard 的租户 → 数字静默错误。3 张平台表无 tenant_id（`event_ledger_authority` 单例、`event_ledger_consumer_checkpoints` 全局 offset、`schema_migrations` 每实例）。若干后台 worker 跨租户迭代（settlement/dual-write-flush/evidence-collector）。
3. **迁移会漏密钥**：唯一现成的租户搬迁原语是 GDPR export/import（`privacy-service.ts:434/760`，FK 有序、事务、覆盖全部租户表），但它**故意脱敏密钥**（`api_key_hash`/`llm_provider_credentials.api_key_encrypted`/OAuth token/`object_key`）——迁移用它，租户到新 shard 会 API key 全废。

**低风险确认（agent 核实）：** 无任何跨租户单事务写（compile lease/earning/workforce/marketplace 全是单租户事务，org 在租户内，wake handler drop 跨租户事件）。故**不需要分布式 2PC**——跨租户只有只读 metrics fan-out + 跨租户迭代 worker（各自 per-shard 跑即可）。

## 总体架构

**一句话：** 在 `createDatabase`/`TenantOSFactory` 之间插一个 `ShardRouter`，按 `tenantId` 一致性哈希查 `tenant_shard` 映射表 → 返回该 shard 的 `IDatabase`（per-shard 连接池，按 shard 缓存）；`TenantDatabase` 包装不变。跨租户聚合改协调层 scatter-gather；租户搬迁复用（去脱敏的）GDPR export/import。

```
request.tenantId ──► TenantOSFactory.getTenantOS(tenantId)
                        │
                        ├─ ShardRouter.dbFor(tenantId)   ← 查 tenant_shard 表（缓存）
                        │      └─ 按 shard_id 取/建 per-shard pool（按 shard 缓存，非按 tenant）
                        ▼
                     TenantDatabase(shardDb, tenantId)   ← WHERE tenant_id=? 不变
```

**协调库（coordinator DB）** 持有分片控制平面：`tenant_shard(tenant_id PK, shard_id, state)` + 平台级表（`event_ledger_authority` 等，Phase 2 决定放这或每 shard）。

## 阶段分解（依赖顺序 + 每阶段可独立交付）

### Phase 0 — 分片地基（ShardRouter，默认单 shard，行为等价现状）

**目标：** 建路由机制但**不启用多库**——默认一个 shard，行为与现状字节等价（零回归）。真多库能力搭好不启用。

**组件：**
- **`ShardRouter`（新，`src/storage/shard-router.ts`）** —— 单一职责：
  - `dbFor(tenantId: string): IDatabase` —— 查 shard 映射 → 返回该 shard 的 `IDatabase`（同步；shard 已缓存则直接返回）。
  - 内部：`shardIdFor(tenantId)` 一致性哈希（或查 `tenant_shard` 表，缺省回落哈希）；`poolFor(shardId)` 按 **shardId** 缓存 `IDatabase`（同 shard 的多租户共享一个池——防连接爆）。
  - 单 shard 配置时：所有 tenantId → 同一个 shard → 同一个 `IDatabase`，等价现状。
- **配置扩展（`config/schema.ts`）：** `db.shards?: Record<shardId, { connectionString }>` + `db.coordinator?: { connectionString }`。缺省（无 shards）→ 单库模式，`createDatabase` 行为不变（向后兼容）。
- **路由接线（`tenant-os-factory.ts:111`）：** `new TenantDatabase(this.shardRouter.dbFor(tenantId), tenantId)` 替换 `new TenantDatabase(this.db, tenantId)`。单 shard 下 `dbFor` 恒返回同一 db。

**连接生命周期（agent 硬约束）：** per-shard 池缓存**按 shard 键**，不按 tenant——64 个缓存租户散在 N 个 shard，池数 = 去重 shard 数，每池 `pool.max`（默认 10）。按 tenant 缓存会连接爆。

**不变量：**
1. 单 shard 配置下，路由行为与现状字节等价（同 tenantId → 同 db，全量测试零回归）。
2. 一致性哈希稳定：同 tenantId 恒映同 shard（可复现，不用 Math.random）。
3. per-shard 池按 shard 去重缓存：同 shard 的多租户共享一个池。
4. `tenant_shard` 表有映射时优先用表，无则回落哈希（表是权威、哈希是缺省）。

**YAGNI：** Phase 0 不碰 default、不改 metrics、不做迁移。只搭机制。

### Phase 1 — 解除 `default` 不可分片阻断点

**目标：** 让 `default` 能像普通租户一样走路由（否则最热租户永卡 host DB，分片无收益）。

**问题：** 20+ 处 `if (tenantFactory && tid !== 'default') return tenantFactory.getTenantOS(tid); return os;`（`memory-facade.ts:108` 等）。`default` 绕过工厂。

**方案（择一，Phase 1 spec 内定）：**
- **A（推荐，小）：** `default` 固定钉在一个「home shard」（可以就是协调库/shard 0）。保留 `!== 'default'` 特例，但让 `ShardRouter.dbFor('default')` 明确返回 home shard db。companion 负载集中在 home shard，可后续再拆。**改动最小**——不动 20 个路由，只让路由器认识 default。
- **B（大）：** 拆掉所有 `!== 'default'` 特例，`default` 经 `getTenantOS('default')` 正常路由。彻底但跨 20 文件、风险高。

**推荐 A**：把「default 结构特殊」收敛成「default 有个固定 home shard」，用一处路由器逻辑替代 20 处特例的语义。B 留作真需要拆分 companion 负载时再做。

**不变量：** default 路由到确定的 home shard；companion/未认证流走 default 仍正常；20 处特例行为不回归（A 方案下它们仍走 host os，但 host os 的 db = home shard db）。

### Phase 2 — 跨租户聚合 fan-out + 平台表归位

**目标：** 让 `/metrics` 等跨租户读在多 shard 下返回正确的全局数字，而非本 shard 局部。

**组件：**
- **协调层 scatter-gather（metrics）：** `MetricsQueryService` 从「单 db」改为「遍历所有 shard，各自查，协调层合并」：
  - SUM 类（rollup/queue/billing-outbox）→ 各 shard 求和再相加。
  - tenant usage（已按 tenant keyed）→ 各 shard 结果 concat。
  - **population diversity（O(n²) 全量 decision_style）→ 拉所有 shard 的 decision_style 行做并集，再跑 `personalityDiversity()`**（成对函数需全量人口）。
- **跨租户 worker per-shard 化：** settlement-reconciliation / dual-write-flush / evidence-collector 改为每 shard 跑一份（各自枚举本 shard 租户）。
- **平台表归位（3 张无 tenant_id）：** `event_ledger_authority`（单例）→ 协调库；`event_ledger_consumer_checkpoints`（全局 offset）→ 每 shard 或重键 `(shard, consumer_id)`；`schema_migrations` → 保持每实例（每 shard 独立跑同一迁移集，须 lockstep）。

**不变量：** metrics 全局数字 = 各 shard 之和/并集（用 2 shard 测：分别塞数据，断言聚合 = 合并值）；diversity score 在多 shard 下等于单库同数据的值。

### Phase 3 — 租户搬迁（rebalance）

**目标：** 一个租户从 shard A 挪到 B，数据完整、密钥不丢、可重跑。

**方案（复用 GDPR 机制 + 补全保真）：**
- **全保真导出**：GDPR `exportData` 加一个「migration 模式」标志——**不脱敏**（导出 `api_key_encrypted`/OAuth ciphertext/`object_key` 原值）。这是 GDPR export 与迁移的唯一实质差异。
- **cutover saga（无跨库事务 → 幂等可重跑步骤）：** `tenant_shard.state='migrating'`（冻源）→ 全保真 export → import 到 B（`ON CONFLICT DO UPDATE` 幂等）→ 校验行数 → 原子翻 `tenant_shard.shard_id=B, state='active'` → erase 源 → evict OS 缓存。
- **密钥可达性：** KMS/envelope 密钥不在 shard DB，须保证 B 的进程能访问该租户的 KMS 引用（`tenant_key_versions` 随数据走，但 KMS 主密钥在外部——设计须确认 B 可解密）。

**不变量：** 迁移后租户在 B 上功能完整（API key 可用、BYOK LLM 可用、媒体引用可解）；saga 任一步中断可重跑不损坏；迁移中租户读写被 `state='migrating'` 冻结。

## 明确不做（YAGNI，全 spec 范围）

- 不做分布式 2PC（已证实无跨租户单事务写）。
- 不做自动 rebalance 决策（Phase 3 只做「执行搬迁」，何时搬由人工/后续）。
- 不做读写分离/副本（另一条路，本 spec 不涉及）。
- 不改 `IDatabase` 同步契约（路由在构造时解析 shard，不引入 async 查询）。
- 不动业务 SQL / 不改 `TenantDatabase` 的 WHERE 注入。

## 依赖顺序与交付

```
#4（编译锁 per-persona，PR #312 待合）
   ▼
Phase 0（地基 ShardRouter，默认单库零回归）  ← 可独立合，不启用多库
   ▼
Phase 1（default 归位）+ Phase 2（fan-out）   ← 可并行设计，Phase 2 依赖 Phase 0 的多 shard 遍历能力
   ▼
Phase 3（迁移）                               ← 依赖 Phase 0 的 shard map + 全保真导出
```

Phase 0 是**唯一低风险、可先独立交付**的一阶段（默认单库、行为等价）。Phase 1-3 各自成 plan，按上面顺序做。

## 本地验证策略（全 spec）

- Phase 0：单测 ShardRouter（哈希稳定/池按 shard 缓存/单库等价）+ 全量回归零回归。
- Phase 1：default 路由到 home shard 测试 + companion 流回归。
- Phase 2：**2 shard 集成测试**（内存 SQLite 起两个 db 当两 shard），塞数据分别落两 shard，断言 metrics 聚合 = 合并值。
- Phase 3：迁移 saga 集成测试（源→目标搬迁，校验全保真 + 幂等重跑 + 冻结）。
- 每阶段 typecheck + build + 相关回归；失败即止。

## 风险

- **高（整体）**，但**分阶段后 Phase 0 低**（默认单库、纯机制、零回归）。真风险集中在 Phase 1（跨 20 文件的 default 语义）+ Phase 2（metrics 静默错误——聚合返回局部值不报错）+ Phase 3（迁移保真 + saga 原子性）。缓解：分阶段独立交付 + 每阶段独立审查；Phase 2 的「静默错误」用 2-shard 集成测试挡（断言聚合值 = 合并值，错了就红）。
- 跨审：本 spec 交 Codex 交叉审查（Claude 生成→Codex 审）。
