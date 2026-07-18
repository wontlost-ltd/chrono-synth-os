# PersonaCoreService 双入口化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PersonaCoreService（聚合根 facade + 4 子服务）双入口化——public wrapper 入口解析租户+开事务，InTx primitive 收 tx 贯穿事务闭包全部 db 访问；recoverTimedOut cross-tenant fan-out 逐 shard 隔离。为分片铺路，单库零回归。

**Architecture:** 路径 (a)：facade 单点解析 db 向下传。public 方法 `const db=source.forTenant(tenantId); db.transaction(()=>this.xInTx(db,...))`；InTx primitive 收 `tx: TransactionContext`（不暴露 transaction，编译期禁嵌套）贯穿到子服务/hook/认知投影/audit。同 tenantId 恒解析同 db（dbForTenant 确定性）→ 跨子服务同事务不裂脑。**不修既有原子缺口**（D6-D8/createFork/applyToTask insertMemory 事务外位置保持原样，单库逐字等价）。

**Tech Stack:** TypeScript (NodeNext ESM `.js`)，node:test，SQLite+PG，`@chrono/kernel` pcore 命令，FakeMultiShardResolver。

**调用矩阵：** `.superpowers/sdd/persona-call-matrix.md`（实现前必读——23 事务点、2 双身份、8 深层 tx 点、hook 转发链全列）。

## Global Constraints

- **零回归铁律**：单库（SingleDbResolver）+ UoW 模式 db 副作用**逐字等价现状**——含既有原子缺口（D6-D8 insertMemory 事务外、createFork/applyToTask 无事务）**原样保留**，不趁 resolver 化改事务边界。全量 unit fail=0。
- **跨子服务事务边界铁律（安全命脉）**：一次 facade 事务方法内，facade 写 + 所有子服务写 + hook + 认知投影 + audit 落**同一物理连接同一事务**——facade 入口解析一次 db 向下传，**事务闭包内一切 db 访问用显式传入 tx，不碰构造期 this.tx**。
- **public wrapper + InTx primitive**：public 解析租户+开事务→调 InTx；InTx 收 `TransactionContext = Pick<SyncWriteUnitOfWork,'queryOne'|'queryMany'|'execute'>`（**不暴露 transaction，编译期结构性禁嵌套**）；禁止解析 source。
- **双身份方法一对入口**（2 个）：`openGovernanceCase`（public + `openGovernanceCaseInTx`）、`settleTaskPayment`（public + `settleTaskPaymentInTx`）。**保持现有调用时序**——不把 disputeTask/acceptSubmittedTask 的两阶段改原子（那是既有语义，不修），只让双身份方法有 InTx 变体供事务内复用；但**现有 disputeTask/acceptSubmittedTask 保持先独立调 public 版**（零回归），InTx 变体本片仅为契约完整性存在（供未来原子化用），除非其调用点本就在事务内（核对矩阵：disputeTask 的 openGovernanceCase 在事务前调——保持；acceptSubmittedTask 的 settleTaskPayment 事务后调——保持）。
  > 即：本片双身份方法**提供** InTx 变体（InTx 契约要求），但**不改**现有两阶段调用点（零回归）。InTx 变体被 facade 内部真正在事务内调的场景才接入。
- **cross-tenant recoverTimedOut**：marketplace 遍历 allShardDbs() 逐 shard 隔离，返回 +shardErrors，worker 适配。
- **ensureAuditLogColumns 移除**：核验列已在迁移；DDL 归迁移不在 service 层。
- **canonical tenantId**：db 解析 + encryptionResolver 用同一 canonical tenantId，禁止子服务重新推导。
- **构造点分类以声明静态类型为准**：7 生产全 fromResolver（IDatabase），测试 fromUnitOfWork；别名靠 typecheck 兜底。
- 注释简体中文；ESM `.js`；无 Math.random（保留现有 Date.now/clock）。

---

### Task 1: 引入 TransactionContext 类型 + PersonaCoreSource + facade 双入口骨架（暂不迁移子服务）

**Files:**
- Modify: `src/persona-core/persona-core-service.ts`（私有构造器 + fromResolver/fromUnitOfWork + PersonaCoreSource + TransactionContext 定义；facade 自有方法先改 source 取 db，子服务调用暂保持现状 this.tx——本 task 只立骨架，全量迁移在后续 task）
- Test: `src/test/unit/persona-core-uow-entrance.test.ts`（现有测试适配 + 加双入口断言）

**Interfaces:**
- Produces: `PersonaCoreSource { forTenant(tenantId): SyncWriteUnitOfWork; allDbs(): SyncWriteUnitOfWork[] }`；`type TransactionContext = Pick<SyncWriteUnitOfWork,'queryOne'|'queryMany'|'execute'>`；`PersonaCoreService.fromResolver(resolver, encryption?, runtimeSessionTimeoutMs?, encryptionResolver?, clock?)` / `fromUnitOfWork(tx, ...)`。

> **实现注意**：本 task 是骨架——facade 私有化构造器 + 两工厂 + source。**因构造器私有化会让全部 7 构造点 + 子服务构造编译红，本 task 必须同时迁移 7 构造点**（见 Task 5 清单，提前到此保编译）——或本 task 暂保留兼容构造，Task 5 删。**推荐**：Task 1 私有化 + 迁移 7 构造点 + 子服务暂持 facade 传下的 db（facade 构造期 `const db0 = source 的某默认？`）——**问题**：fromResolver 无构造期单一 db。故 Task 1 必须已让子服务改为「不构造期绑 db、方法收 tx」——即 Task 1 与 Task 2/3 有强耦合，**无法干净拆分**。

- [ ] **Step 0（关键，先做）: 重新评估 task 边界**

因构造器私有化 + fromResolver 无构造期单一 db，「facade 骨架」与「子服务 InTx 化」**无法分 task**（子服务不能再构造期绑 tx，否则 fromResolver 模式无 db 可绑）。**修正 task 划分**：Task 1 = 整个 facade + 4 子服务 + hook 接口的 InTx 化 + 构造点迁移，作**一个原子 task**（这是本片不可分的核心，因编译原子性 + 事务闭包一致性）。后续 task = recoverTimedOut fan-out（相对独立）、ensureAuditLogColumns 移除、探针、回归。

**→ 实现者：按下方修正后的 Task 结构执行（Task 1 合并为核心大 task）。**

---

### Task 1（修正）: PersonaCoreService + 4 子服务 InTx 化 + 构造点原子迁移（核心大 task）

**Files:**
- Modify: `src/persona-core/persona-core-service.ts`（facade）
- Modify: `src/persona-core/persona-memory-service.ts` / `persona-wallet-service.ts` / `persona-governance-service.ts` / `persona-marketplace-service.ts`（4 子服务）
- Modify: 4 Context 接口 + 3 Hook 接口（加 InTx 变体签名）
- Modify: 7 生产构造点（memory-facade:100 / app.ts:444 / admin-templates:32 / persona-core:348 / tasks:14 / personas:32 / runtime-recovery-worker:87）
- Modify: 测试构造点 → fromUnitOfWork
- Test: `persona-core-uow-entrance.test.ts`

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`、调用矩阵。
- Produces: facade + 子服务双入口/InTx 化。

- [ ] **Step 1: 读调用矩阵，写失败测试**

读 `.superpowers/sdd/persona-call-matrix.md` 全表。在 `persona-core-uow-entrance.test.ts` 加：
```ts
it('fromResolver：createPersona 落对应 db + 跨子服务同事务', () => {
  const db = createMemoryDatabase(); runDslSqliteMigrations(db);
  const svc = PersonaCoreService.fromResolver(new SingleDbResolver(db));
  svc.createPersona({ tenantId: 't1', ownerUserId: 'u1', /* 按现有 createPersona 入参 */ });
  // 断言 persona_core 行 + memory 行落 db（同一 db）
  assert.ok(db.prepare('SELECT 1 FROM persona_core WHERE tenant_id=?').get('t1'));
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head; node --test --test-force-exit dist/test/unit/persona-core-uow-entrance.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL（fromResolver 不存在 / 私有构造器致构造点红）。

- [ ] **Step 3: facade 双入口 + TransactionContext**

facade 私有构造器 `private constructor(source: PersonaCoreSource, encryption?, runtimeSessionTimeoutMs?, encryptionResolver?, clock?)` + `fromResolver`/`fromUnitOfWork`（config/encryption/clock 位保留）。定义 `type TransactionContext = Pick<SyncWriteUnitOfWork,'queryOne'|'queryMany'|'execute'>`。**移除 `ensureAuditLogColumns(tx)` 构造期调用**（见 Task 3 迁移核验；若列未在迁移，先做 Task 3 再回来）。

- [ ] **Step 4: facade public/InTx 化（按矩阵）**

每个 facade 公共写方法：`public xxx(input) { const db = this.source.forTenant(input.tenantId); return db.transaction(() => this.xxxInTx(db, input)); }` + `private xxxInTx(tx: TransactionContext, input) { tx.execute(...); this.memoryService.insertMemoryInTx(tx, {...}) }`。只读方法：`const db = this.source.forTenant(tenantId)` 直接读。原 `this.tx.xxx` → 相应 db/tx。**8 深层点**（矩阵 D1-D8：recordBusinessAudit / getCognitive / projectKnowledgeItem / projectEventMemory / 3 marketplace insertMemory hook / ...）改用传入 tx。

- [ ] **Step 5: 4 子服务 InTx 化 + Context/Hook 接口加 tx**

子服务 primitive 写方法（insertMemory/insertGovernanceEvent/insertWalletTransaction/insertGrowthEvent/insertReputationHistory 等）加 `InTx(tx, ...)` 变体收 tx（矩阵列的）。4 Context 接口 + 3 Hook 接口加 InTx 签名。**双身份方法 openGovernanceCase / settleTaskPayment 一对入口**（public + InTx）。**保持现有 insertMemory 事务内/外位置 + disputeTask/acceptSubmittedTask 两阶段时序不变**（零回归——不修既有原子缺口）。子服务是否还持 this.tx：改为「方法收 tx，不再构造期绑 db」（fromResolver 模式无构造期 db）；facade 构造子服务时不再传 tx（或传 source？——子服务 InTx 方法全收 tx，构造只需 context/clock 等无 db 依赖）。

- [ ] **Step 6: 迁移 7 构造点 + 测试构造点（同提交保编译）**

7 生产 → `fromResolver(new SingleDbResolver(x), ...)`（persona-core:348 保 encryption/timeout/encryptionResolver 参；tasks:14 保三元；personas:32 os.getDatabase()）。测试 → `fromUnitOfWork`。别名 grep + typecheck 兜底。

- [ ] **Step 7: typecheck 权威无残留 + build + 测试绿**

Run:
```bash
npm run typecheck 2>&1 | grep -c "error TS"
npm run build >/dev/null 2>&1; echo "build=$?"
grep -rn "new PersonaCoreService(" src --include="*.ts" | grep -v "persona-core-service.ts" && echo "!!!残留" || echo "零残留"
node --test --test-force-exit dist/test/unit/persona-core-uow-entrance.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；无残留；测试绿。

- [ ] **Step 8: 提交**

```bash
git add src/persona-core/ src/core/memory-facade.ts src/server/app.ts src/server/routes/{admin-templates,persona-core,tasks,personas}.ts src/persona-core/runtime-recovery-worker.ts src/test/unit/persona-core-uow-entrance.test.ts
git commit -m "$(printf 'feat(persona): PersonaCoreService+4子服务 InTx 化双入口（facade 单点解析向下传）\n\npublic wrapper 解析租户+开事务→InTx primitive 收 TransactionContext（不暴露 transaction\n编译期禁嵌套）贯穿子服务/hook/认知投影/audit。双身份 openGovernanceCase/settleTaskPayment\n一对入口。保持既有 insertMemory 事务内外位置+两阶段时序（零回归不修既有原子缺口）。\n7 构造点原子迁移。ensureAuditLogColumns 移除（DDL 归迁移）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: recoverTimedOutRuntimeSessions cross-tenant fan-out（逐 shard 隔离）

**Files:**
- Modify: `src/persona-core/persona-marketplace-service.ts`（recoverTimedOutRuntimeSessions fan-out）
- Modify: `src/persona-core/persona-core-service.ts`（facade 委托签名）
- Modify: `src/persona-core/runtime-recovery-worker.ts`（RuntimeRecoveryResult + shardErrors 日志）
- Test: worker 现有测试适配

**Interfaces:**
- Produces: `recoverTimedOutRuntimeSessions` 遍历 allShardDbs 逐 shard 隔离，返回 `{ scanned, recovered, timedOut, shardErrors: {shard,error}[] }`。

- [ ] **Step 1: 写失败测试**（多 shard 各预置超时 session → 都恢复 + 一 shard throwingDb → shardErrors 记它其余仍恢复）
- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: marketplace recoverTimedOut fan-out**：遍历 `this.source.allDbs()`，每 shard 各跑 pcoreQueryTimedOutRuntimeSessions + 逐行 retry/timeout，逐 shard try/catch 隔离（不 rethrow，记 shardErrors），聚合 scanned/recovered/timedOut 求和。
- [ ] **Step 4: facade 委托 + worker 适配**：facade recoverTimedOut 签名带 shardErrors；worker flushInternal 读 shardErrors 做日志，RuntimeRecoveryResult 加字段，现有 counter-shape 测试适配。
- [ ] **Step 5: typecheck + build + 测试绿**
- [ ] **Step 6: 提交**

---

### Task 3: ensureAuditLogColumns 迁移核验

**Files:** 可能 Modify: 迁移文件（若列缺）

- [ ] **Step 1: 核验**：`grep -rn "audit_log" packages/schema-dsl/src/migrations`——确认 audit_log 表的列（ensureAuditLogColumns 补的那些）已在迁移建（已知 v040 audit 扩展 / v073 hash-chain）。
- [ ] **Step 2**：若已在迁移 → Task 1 Step 3 已删构造期调用，本 task 仅确认（无改动）；若缺列 → 补迁移（按 schema-dsl migration sync points：迁移文件/index/version-map/parity/legacy fixture/VERSION_MAP range 6 处同步 + 重建 schema-dsl dist）。
- [ ] **Step 3: 全量 golden + 迁移 parity 测试绿**（若改迁移）。

---

### Task 4: 探针测试（10 类 + 变异，含原子回滚故障注入）

**Files:**
- Create: `src/test/unit/persona-core-service-sharding.test.ts`

- [ ] **Step 1: 写 10 类探针**（按 spec 验收段）：1 分流对称 / 2 跨子服务同 db（persona+memory+认知投影同 shard）/ 3 原子回滚故障注入（子服务写后注入异常→全回滚，SQLite+PG）/ 4 深层 tx 变异（getCognitive/projectKnowledgeItem 用旧 tx→红）/ 5 hook 覆盖（marketplace→wallet 等）/ 6 嵌套事务变异（InTx 内调 transaction→SQLite 失败/PG 无残留）/ 7 recoverTimedOut fan-out+部分失败隔离 / 8 encryptionResolver canonical tenantId / 9 UoW / 10 单库零回归。用 FakeMultiShardResolver + throwingDb + loadConfig。
- [ ] **Step 2: 跑确认全绿**
- [ ] **Step 3: 变异证明**（forTenant 固定→分流红；深层 tx 用旧 this.tx→探针 2/4 红；InTx 内 transaction→嵌套红。各还原）
- [ ] **Step 4: 提交**

---

### Task 5: 全量回归 + ratchet 验证（纯验证）

- [ ] **Step 1: 无残留**（typecheck 0 + grep 外部零 `new PersonaCoreService(`）
- [ ] **Step 2: 全量 unit 回归**（fail=0，baseline 本片前 2120）
- [ ] **Step 3: ratchet**（26 条不变或按 inventory 更新——PersonaCoreService 相关 longlived-root-capture 条目 personas/admin-templates/memory-facade 核验：改双入口后是否仍命中 ratchet，条目保留）
- [ ] **Step 4: 集成点验**（persona 相关集成测试）
- [ ] **Step 5: 无提交或补记**

---

## Self-Review

**1. Spec coverage**：facade+子服务 InTx 化+构造点迁移→Task1；recoverTimedOut fan-out→Task2；ensureAuditLogColumns→Task3；10 探针→Task4；回归→Task5。✓
**2. Placeholder**：Task 1 Step 4/5 引用调用矩阵具体分类（矩阵是外部文件，非占位）；探针入参「按现有 createPersona 入参」需实现者核对真实签名——有意核对指令。
**3. Type consistency**：`PersonaCoreSource`/`TransactionContext`/`fromResolver` Task1 定义，Task2/4 一致。
**4. 编译原子性（关键）**：Task 1 是**不可分的核心大 task**——facade 私有化 + 4 子服务 InTx + 7 构造点必须同提交（fromResolver 无构造期 db，子服务不能再绑 tx）。Task 2-5 建立在 Task 1 已 InTx 化基础。

**注意点（实现者）：**
- **Task 1 是本片最大最难 task**，涉及 5 类 + 23 事务点 + 8 深层点 + 2 双身份 + 4 context/3 hook 接口 + 7 构造点。实现者可能报 DONE_WITH_CONCERNS 或需拆——若 Task 1 过大无法一次完成，按子服务拆（facade+memory 一提交、wallet、governance、marketplace 各一提交），但**每提交须编译过**（难点：中间态子服务混合 this.tx/传入 tx）。控制者按 SDD BLOCKED 处理，可能需 re-dispatch 更强模型或拆更细。
- **零回归铁律高于一切**：既有原子缺口（D6-D8/createFork/applyToTask insertMemory 事务外）**原样保留**，别趁 InTx 化"顺手修"。
- 调用矩阵 `.superpowers/sdd/persona-call-matrix.md` 是权威，实现前通读。
- 探针 3（原子回滚故障注入）+ 6（嵌套变异）需 SQLite + PG 各验——PG 需 testcontainers（本机 podman ryuk 配置，见 memory）。
