# PersonaTemplateService 双入口化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PersonaTemplateService 双入口化——CRUD per-tenant→dbForTenant、syncBuiltins cross-tenant→allShardDbs fan-out（每 shard 一份，失败则抛）、instantiate 级联与 PersonaCoreService 共享同一 resolver。单库零回归。

**Architecture:** 单类（+ 依赖已双入口的 PersonaCoreService），比 persona 块第一片轻。私有构造器 + fromResolver/fromUnitOfWork + `TemplateSource {forTenant, allDbs}`。CRUD 入口 forTenant 解析（update/delete 用 private getFromDb 兑现「解析一次」）；syncBuiltins fan-out 每 shard 刷全部 BUILTIN 模板；instantiate 与 PersonaCoreService 共享同一 resolver（同 tenantId 同 db 不裂脑，非原子=既有）。

**Tech Stack:** TypeScript (NodeNext ESM `.js`)，node:test，SQLite，`@chrono/kernel` ptpl 命令，FakeMultiShardResolver。

## Global Constraints

- **零回归铁律**：单库（SingleDbResolver）+ UoW 模式 db 副作用逐字等价现状——含 update/delete 既有 TOCTOU、instantiate 非原子（无外层事务）原样保留，不趁机加事务。全量 unit fail=0。
- **CRUD 经 forTenant**：list/get/create 单条无需事务；update/delete 先读后写，**入口解析一次 db，get(读)+execute(写)用同一 db**（private `getFromDb(db,tenantId,templateId)`，public get/update/delete/instantiate 共用，不再各自解析）。
- **syncBuiltins fan-out 每 shard 一份**：遍历 allShardDbs()，每 shard 刷全部 BUILTIN_TEMPLATE_SEEDS；逐 shard 尝试聚合 errors（含 fan-out index 身份），**任一失败则最终抛**（启动 seed 语义，非隔离）。
- **强制组合装配**：2 生产构造点先建单一 resolver 变量→PersonaCoreService.fromResolver(resolver)→PersonaTemplateService.fromResolver(**同 resolver**, core)。禁两边分别 new resolver（两真 ShardRouter 不共享池缓存会落不同 db）。
- **级联不裂脑**：instantiate 里 template.source 与 personaCoreService.source 独立解析，但同 resolver+同 tenantId → dbForTenant 确定性 → 同 db。
- **UoW 模式 forTenant 忽略 tenantId 恒返 tx**；allDbs=[tx]。
- **内置模板每 shard 一份**：不改 list/get 单-SQL `OR '__builtin__'` 查询模型。
- **shardErrors 用 fan-out index**（String(i)）非真 shardId（allShardDbs 无 shardId）。
- inventory：personas/admin-templates longlived-root-capture 条目核验保留；`check:db-access` 通过。
- 注释简体中文；ESM `.js`；无 Math.random（保留现有 Date.now）。
- 构造点分类以声明类型为准；无别名但 typecheck 兜底。

---

### Task 1: PersonaTemplateService 双入口 + syncBuiltins fan-out + 构造点原子迁移

**Files:**
- Modify: `src/enterprise/persona-template-service.ts`（私有构造器 + fromResolver/fromUnitOfWork + TemplateSource + getFromDb helper + CRUD forTenant + syncBuiltins fan-out + instantiate 级联）
- Modify: `src/server/app.ts:445`、`src/server/routes/admin-templates.ts:34`（2 生产构造点，组合装配同 resolver）
- Modify: `src/test/unit/persona-template-service.test.ts:32`（测试构造点 → fromUnitOfWork）
- Test: `persona-template-service.test.ts`（加双入口断言）

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`、已双入口的 `PersonaCoreService`。
- Produces: `PersonaTemplateService.fromResolver(resolver, personaCoreService)` / `fromUnitOfWork(tx, personaCoreService)`；CRUD/syncBuiltins/instantiate 签名不变，内部 source 化。

- [ ] **Step 1: 写失败测试（双入口 + syncBuiltins fan-out 最小断言）**

在 `persona-template-service.test.ts` 加：
```ts
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
// 已有 PersonaTemplateService/PersonaCoreService/createMemoryDatabase import

it('fromResolver：syncBuiltins 落 db + create/list per-tenant', () => {
  const db = createMemoryDatabase(); runDslSqliteMigrations(db);
  const resolver = new SingleDbResolver(db);
  const core = PersonaCoreService.fromResolver(resolver);
  const svc = PersonaTemplateService.fromResolver(resolver, core);
  svc.syncBuiltins();
  const builtins = svc.list('t1').filter(t => t.isBuiltIn);
  assert.ok(builtins.length > 0, '内置模板可见');
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head; node --test --test-force-exit dist/test/unit/persona-template-service.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL（fromResolver 不存在 / 私有构造器致构造点红）。

- [ ] **Step 3: 重构 PersonaTemplateService**

`src/enterprise/persona-template-service.ts`：
```ts
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
interface TemplateSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  allDbs(): SyncWriteUnitOfWork[];
}
export class PersonaTemplateService {
  private constructor(
    private readonly source: TemplateSource,
    private readonly personaCoreService: PersonaCoreService,
  ) { registerCoreSelfExecutors(); }

  static fromResolver(resolver: TenantDbResolver, personaCoreService: PersonaCoreService): PersonaTemplateService {
    return new PersonaTemplateService({ forTenant: (t) => resolver.dbForTenant(t), allDbs: () => resolver.allShardDbs() }, personaCoreService);
  }
  static fromUnitOfWork(tx: SyncWriteUnitOfWork, personaCoreService: PersonaCoreService): PersonaTemplateService {
    return new PersonaTemplateService({ forTenant: () => tx, allDbs: () => [tx] }, personaCoreService);
  }

  /** db-bound 读 helper（public get + update/delete/instantiate 共用，兑现「解析一次」）。 */
  private getFromDb(db: SyncWriteUnitOfWork, tenantId: string, templateId: string): PersonaTemplate | null {
    const row = db.queryOne(ptplQueryById({ templateId, tenantId, builtinTenantId: BUILTIN_TENANT_ID }));
    return row ? rowToTemplate(row) : null;
  }

  list(tenantId: string): PersonaTemplate[] {
    const rows = this.source.forTenant(tenantId).queryMany(ptplQueryList({ tenantId, builtinTenantId: BUILTIN_TENANT_ID }));
    return rows.map(rowToTemplate);
  }
  get(tenantId: string, templateId: string): PersonaTemplate | null {
    return this.getFromDb(this.source.forTenant(tenantId), tenantId, templateId);
  }
  create(tenantId: string, input: CreateTemplateInput): PersonaTemplate {
    // ...现有逻辑，this.tx.execute → this.source.forTenant(tenantId).execute
  }
  update(tenantId: string, templateId: string, input: PatchTemplateInput): PersonaTemplate {
    const db = this.source.forTenant(tenantId);          // 解析一次
    const existing = this.getFromDb(db, tenantId, templateId);  // get 用同一 db
    if (!existing) throw new PersonaTemplateNotFoundError(templateId);
    if (existing.isBuiltIn) throw new BuiltInTemplateImmutableError(templateId);
    // ...next 组装，db.execute(ptplCmdUpdate(...))
  }
  delete(tenantId: string, templateId: string): void {
    const db = this.source.forTenant(tenantId);
    const existing = this.getFromDb(db, tenantId, templateId);
    if (!existing) throw new PersonaTemplateNotFoundError(templateId);
    if (existing.isBuiltIn) throw new BuiltInTemplateImmutableError(templateId);
    db.execute(ptplCmdDelete({ templateId, tenantId }));
  }

  /** cross-tenant fan-out：每 shard 刷全部内置 seed；逐 shard 尝试聚合 errors，任一失败则抛。 */
  syncBuiltins(): void {
    const now = Date.now();
    const errors: { shard: string; error: string }[] = [];
    const dbs = this.source.allDbs();
    for (let i = 0; i < dbs.length; i++) {
      try {
        for (const seed of BUILTIN_TEMPLATE_SEEDS) {
          dbs[i]!.execute(ptplCmdUpsertBuiltin({ id: seed.id, tenantId: seed.tenantId, /* ...现有字段 */ now }));
        }
      } catch (err) {
        errors.push({ shard: String(i), error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (errors.length > 0) {
      throw new Error(`syncBuiltins 部分 shard 失败（启动 seed 须全成功）: ${errors.map(e => `shard ${e.shard}: ${e.error}`).join('; ')}`);
    }
  }

  instantiate(input: InstantiateTemplateInput): InstantiateTemplateResult {
    const db = this.source.forTenant(input.tenantId);   // 解析一次（模板/audit 用）
    const template = this.getFromDb(db, input.tenantId, input.templateId);
    if (!template) throw new PersonaTemplateNotFoundError(input.templateId);
    // ...现有 vars/profile/initialKnowledge 组装
    const persona = this.personaCoreService.createPersona({ tenantId: input.tenantId, /* ... */ });  // core 用自己 source（同 resolver→同 db）
    recordBusinessAuditLog(db, { tenantId: input.tenantId, /* ... */ });  // audit 用同一 db（原 this.tx→db）
    return { /* ... */ };
  }
}
```
（保持 instantiate 三段无外层事务=既有非原子；create/update/delete 的字段组装逻辑不变，只换 db 取源。）

- [ ] **Step 4: 迁移 3 构造点（组合装配同 resolver）**

- `app.ts:445`：现 `new PersonaCoreService(tx); new PersonaTemplateService(tx, bulkImportPersonaCoreService)`——改为（PersonaCoreService 已 Task 1 迁 fromResolver，核对其现状写法）：
  ```
  const bulkResolver = new SingleDbResolver(tx);   // 单一 resolver 变量
  const bulkImportPersonaCoreService = PersonaCoreService.fromResolver(bulkResolver, ...);  // 若已 fromResolver 则复用其 resolver 变量
  const bulkImportTemplateService = PersonaTemplateService.fromResolver(bulkResolver, bulkImportPersonaCoreService);
  ```
  **核实 PersonaCoreService 构造点当前写法**（Task 1 已迁）——若它已 `PersonaCoreService.fromResolver(new SingleDbResolver(tx))`，提取 resolver 为变量复用给 template（禁各自 new）。
- `admin-templates.ts:34`：同款组合装配（提取 resolver 变量给 core + template）。
- 测试 `persona-template-service.test.ts:32` → `fromUnitOfWork(db, personaCoreService)`（core 也 fromUnitOfWork(db) 或 fromResolver(SingleDbResolver(db))——保持测试单库）。

- [ ] **Step 5: typecheck 权威无残留 + build + 测试绿**

Run:
```bash
npm run typecheck 2>&1 | grep -c "error TS"
npm run build >/dev/null 2>&1; echo "build=$?"
grep -rn "new PersonaTemplateService(" src --include="*.ts" | grep -v "persona-template-service.ts" && echo "!!!残留" || echo "零残留"
node --test --test-force-exit dist/test/unit/persona-template-service.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；无残留；测试绿。**核实 app.ts/admin-templates 两生产点确实用同一 resolver 变量传 core+template（组合装配协议）。**

- [ ] **Step 6: 提交**

```bash
git add src/enterprise/persona-template-service.ts src/server/app.ts src/server/routes/admin-templates.ts src/test/unit/persona-template-service.test.ts
git commit -m "$(printf 'feat(enterprise): PersonaTemplateService 双入口（CRUD forTenant + syncBuiltins fan-out + 级联同 resolver）\n\n私有构造器 + fromResolver/fromUnitOfWork + TemplateSource。CRUD 经 forTenant（update/delete\n用 private getFromDb 兑现解析一次）；syncBuiltins fan-out 每 shard 刷全部内置 seed 逐 shard\n聚合 errors 任一失败则抛；instantiate 与 PersonaCoreService 共享同一 resolver（同 tenantId 同 db\n不裂脑，非原子=既有）。2 生产点组合装配传同一 resolver。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: 探针测试（8 类 + 变异）

**Files:**
- Create: `src/test/unit/persona-template-service-sharding.test.ts`

**Interfaces:**
- Consumes: `PersonaTemplateService.fromResolver`/`fromUnitOfWork`、`PersonaCoreService.fromResolver`、`FakeMultiShardResolver`、`SingleDbResolver`、`createMemoryDatabase`+`runDslSqliteMigrations`、`BUILTIN_TENANT_ID`。

- [ ] **Step 1: 写 8 类探针**

创建 `persona-template-service-sharding.test.ts`。helper `tplDb()`=createMemoryDatabase+runDslSqliteMigrations；throwingDb 桩。**关键：template 和 core 用同一 resolver**：
```ts
function stack(resolver: TenantDbResolver) {
  const core = PersonaCoreService.fromResolver(resolver);
  return PersonaTemplateService.fromResolver(resolver, core);
}
```
8 类（按 spec 验收段）：
1. CRUD per-tenant 分流对称：tA→s1、tB→s2；各 create；断言 s1 查得 tA 模板不得 tB、s2 反之（查 persona_templates WHERE tenant_id）。
2. syncBuiltins 每 shard 一份：两 shard resolver；syncBuiltins()；断言两 shard 的 persona_templates 都有全部 `WHERE tenant_id='__builtin__'` 行（COUNT = BUILTIN_TEMPLATE_SEEDS.length）；list(tA)/list(tB) 各查到内置。
3. instantiate 级联同 shard：`stack(r)`；instantiate({tenantId:tA,...})（tA→s1）；断言 s1 有模板+新 persona_core 行+audit_log 行（全 s1）。
4. syncBuiltins 坏 shard 居中则抛：三 shard 中间 throwingDb；syncBuiltins()；断言整体抛 + 前后健康 shard 已刷（查它们有内置行）。
5. syncBuiltins 重跑收敛：一 shard throwingDb 致抛（部分已刷）；换正常 db 重跑；断言不抛 + 全 shard 内置一致。
6. UoW 模式：fromUnitOfWork；CRUD+instantiate 落该 db。
7. 单库零回归：fromResolver(SingleDbResolver(db))；行为等价。
8. update/delete TOCTOU 同 db：update/delete 的 get+execute 落同一 db（同 tenantId），行为等价改造前。

- [ ] **Step 2: 跑确认全绿**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/persona-template-service-sharding.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`

- [ ] **Step 3: 变异证明**

- 变异 A（级联同 resolver）：探针 3 用**不同 resolver** 建 template 和 core（`PersonaTemplateService.fromResolver(r1, PersonaCoreService.fromResolver(r2))`，r1≠r2 指向不同 db）→ 重 build 跑 → 探针 3 应红（persona 落 core 的 db、模板/audit 落 template 的 db，不同 shard）。还原。
- 变异 B（syncBuiltins fan-out）：syncBuiltins 只刷 `allDbs()[0]`（不遍历）→ 探针 2 应红（第二 shard 无内置）。还原。
每变异后 git checkout 还原、重 build 绿。写 report。

- [ ] **Step 4: 提交**

```bash
git add src/test/unit/persona-template-service-sharding.test.ts
git commit -m "$(printf 'test(enterprise): PersonaTemplateService 分片探针（CRUD 分流 + syncBuiltins 每 shard 一份 + 级联同 shard + 重跑收敛）\n\n8 类：CRUD 对称分流/syncBuiltins 每 shard 一份/instantiate 级联同 shard/坏 shard 居中则抛/\n重跑收敛/UoW/零回归/update-delete TOCTOU 同 db。变异（不同 resolver→级联落错 shard 红、\nsyncBuiltins 只刷首 db→第二 shard 无内置红）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: 全量回归 + ratchet 验证（纯验证）

- [ ] **Step 1: 无残留**（typecheck 0 + grep 外部零 `new PersonaTemplateService(`）
- [ ] **Step 2: 全量 unit 回归**（build 0；`node --test --test-force-exit 'dist/test/unit/**/*.test.js'`；fail=0，baseline 本片前 2133）
- [ ] **Step 3: ratchet**（26 条不变；PersonaTemplateService 相关 admin-templates/personas longlived-root-capture 条目核验保留）
- [ ] **Step 4: 集成点验**（admin-control-plane-api 等 persona-template 相关集成测试）
- [ ] **Step 5: 无提交或补记**

---

## Self-Review

**1. Spec coverage**：双入口 CRUD+syncBuiltins fan-out+instantiate 级联+3 构造点→Task1；8 探针+变异→Task2；回归→Task3。✓
**2. Placeholder**：Task1 Step3 现有字段组装「...现有逻辑/字段不变」标注需实现者保留原逻辑只换 db 源——有意（避免抄错既有字段）。Task4 组合装配核实 PersonaCoreService 现状写法——核对指令。无 TBD。
**3. Type consistency**：`TemplateSource {forTenant,allDbs}`/`getFromDb(db,...)`/`fromResolver(resolver, core)` Task1 定义，Task2 一致。
**4. 编译原子性**：Task1 单类私有化 + 3 构造点同提交（单类比 PersonaCoreService 简单，一 task 原子可行）。

**注意点（实现者）：**
- **组合装配同 resolver 是红线**：app.ts/admin-templates 必须提取单一 resolver 变量传 core+template，别各自 new（核实 PersonaCoreService 现构造写法，复用其 resolver 变量）。
- update/delete/instantiate/get 共用 private getFromDb（解析一次），别调会重新解析的 public get。
- instantiate 三段无外层事务=既有非原子，别加事务（零回归）。
- syncBuiltins 失败则抛（启动 seed），非隔离。
- 现有 create/update/delete 字段组装逻辑保留，只换 db 取源。
