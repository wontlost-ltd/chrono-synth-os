# BillingOutbox 双入口化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 BillingOutbox 改为双入口——`enqueue` per-tenant→dbForTenant、`flush`（async 收入上报 worker）/`pendingCount`/`failedCount` cross-tenant→allShardDbs fan-out（**逐 shard 隔离**），并接线定时器持 resolver + 处理 shardErrors。

**Architecture:** enqueue 有 tenantId（per-tenant），flush/count 无 tenantId 全表 worker（cross-tenant）。私有构造器 + `fromResolver`/`fromUnitOfWork` + 内部 OutboxSource（forTenant + allDbs，同 QuotaSource 形状）。flush 提取 `flushOneDb(db)` 单-db 逻辑，外层顺序 await 逐 shard try/catch 隔离（某 shard 挂不拖累其他——有意偏离 QuotaManager fail-fast，因 flush 是收入上报）。单库（SingleDbResolver）+ UoW 模式 db 副作用+计数语义等价现状。

**Tech Stack:** TypeScript (NodeNext ESM, `.js`)，node:test，SQLite 内存库，`@chrono/kernel` billing-outbox 命令，Stripe reportUsage（探针走失败路径不碰真 Stripe）。

## Global Constraints

- **零回归铁律**：单库（SingleDbResolver）+ UoW 模式 db 副作用与计数语义（processed/failed）等价现状（flush 返回加 shardErrors 字段，单库下恒空数组）；全量 unit fail=0。
- **enqueue 经 forTenant；flush/count 经 allDbs fan-out**——不残留直接持单 db。
- **flush 逐 shard 隔离**：某 shard 整体抛不 rethrow、记 `shardErrors: {shard, error}[]`（shard=allDbs 索引身份）、继续其余 shard。**与 QuotaManager prune 的 fail-fast 是有意语义差异**。
- **flushOneDb 内逐行 try/catch 不变**（单行失败 markFailed 不误伤同 shard 其他行）。
- **UoW 模式**：forTenant 忽略 tenantId 恒返 tx（结构上不脱离事务）；allDbs=[tx]，flush 遍历一次等价单库。
- **顺序 await 非并发**（Stripe 限流；outbox 慢而稳）。
- **模块级 fallbackSeqCounter / billingMetrics 保持原样**（进程全局，非 db 状态）；新增 `billingMetrics.meterShardFlushErrors` 计数。
- **batchSize=每 shard 上限**（全局 uniqueShardCount×batchSize），契约明示。
- **无适配层**（IDatabase extends SyncWriteUnitOfWork）。
- **inventory 不动**：BillingOutbox 不命中 ratchet；`check:db-access` 继续通过。
- 注释简体中文；ESM `.js`；无 Math.random（保留 fallbackSeqCounter）。
- **构造点分类以声明静态类型为准**：6 生产点全 fromResolver（声明 IDatabase，含 app.ts:448 别名 P1dBillingOutbox + :867 普通名）+ 测试 fromUnitOfWork。**别名靠 typecheck（TS2673）兜底，非 grep**。

---

### Task 1: BillingOutbox 双入口重构 + async fan-out + 全部 6 构造点原子迁移

**Files:**
- Modify: `src/billing/billing-outbox.ts`（私有构造器 + OutboxSource + fromResolver/fromUnitOfWork + flushOneDb 提取 + flush 逐 shard 隔离 + count fan-out + FlushResult + meterShardFlushErrors）
- Modify（生产构造点 → fromResolver）：`memory-facade.ts:105`、`life-simulations.ts:42`、`decisions.ts:73`、`onboarding.ts:77`、`app.ts:448`（别名 P1dBillingOutbox）、`app.ts:867`（定时器构造点本身；定时器的 flush 结果处理留 Task 2）
- Modify（测试构造点 → fromUnitOfWork）：`billing-uow-entrance.test.ts:41/42/51/73`
- Test: `billing-uow-entrance.test.ts`（构造点适配 + 加一处双入口断言）

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`、`SyncWriteUnitOfWork`、现有 boutbox 命令/查询、reportUsage、Clock。
- Produces: `BillingOutbox.fromResolver(resolver, config, clock?)` / `fromUnitOfWork(tx, config, clock?)`；`enqueue`/`pendingCount`/`failedCount` 签名不变；`flush(batchSize?): Promise<FlushResult>`（`FlushResult = {processed, failed, shardErrors: {shard,error}[]}`）。

- [ ] **Step 1: 写失败测试（双入口 + fan-out 隔离最小断言）**

在 `billing-uow-entrance.test.ts` 加（现有构造点下一步改）：

```ts
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
// 已有 BillingOutbox / createMemoryDatabase / config import

it('BillingOutbox.fromResolver：enqueue 落对应 db + flush 返回 FlushResult', async () => {
  const db = createMemoryDatabase(); runDslSqliteMigrations(db);
  const ob = BillingOutbox.fromResolver(new SingleDbResolver(db), config);
  assert.equal(ob.enqueue('t1', 'cus_1', 'llm_tokens', 100, 'msg-1'), true);
  assert.equal(ob.pendingCount(), 1);
  const r = await ob.flush();
  assert.equal(typeof r.processed, 'number');
  assert.ok(Array.isArray(r.shardErrors), 'flush 返回 shardErrors 数组');
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head; node --test --test-force-exit dist/test/unit/billing-uow-entrance.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL（fromResolver 不存在 / 私有构造器致旧 `new BillingOutbox(` 编译红）。

- [ ] **Step 3: 重构 BillingOutbox**

`src/billing/billing-outbox.ts`——私有构造器 + OutboxSource + 两工厂 + flushOneDb 提取 + flush 逐 shard 隔离。保留模块级 fallbackSeqCounter/billingMetrics（加 meterShardFlushErrors 字段）：

```ts
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
// ...现有 import 保留

interface OutboxSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  allDbs(): SyncWriteUnitOfWork[];
}

export interface FlushResult {
  processed: number;
  failed: number;
  shardErrors: { shard: string; error: string }[];
}

export class BillingOutbox {
  private constructor(
    private readonly source: OutboxSource,
    private readonly config: AppConfig,
    private readonly clock: Clock = realClock,
  ) {
    registerCoreSelfExecutors();
  }

  static fromResolver(resolver: TenantDbResolver, config: AppConfig, clock: Clock = realClock): BillingOutbox {
    return new BillingOutbox({ forTenant: (t) => resolver.dbForTenant(t), allDbs: () => resolver.allShardDbs() }, config, clock);
  }

  static fromUnitOfWork(tx: SyncWriteUnitOfWork, config: AppConfig, clock: Clock = realClock): BillingOutbox {
    return new BillingOutbox({ forTenant: () => tx, allDbs: () => [tx] }, config, clock);
  }

  enqueue(tenantId: string, customerId: string, eventName: string, quantity: number, sourceId?: string): boolean {
    const idempotencyKey = sourceId !== undefined && sourceId.length > 0
      ? `${tenantId}:${eventName}:${sourceId}`
      : `${tenantId}:${eventName}:${this.clock.now()}:${fallbackSeqCounter++}`;
    const result = this.source.forTenant(tenantId).execute(boutboxCmdEnqueue({
      tenantId, customerId, eventName, quantity, idempotencyKey, now: this.clock.now(),
    }));
    return result.rowsAffected > 0;
  }

  async flush(batchSize = 50): Promise<FlushResult> {
    let processed = 0, failed = 0;
    const shardErrors: { shard: string; error: string }[] = [];
    const dbs = this.source.allDbs();
    for (let i = 0; i < dbs.length; i++) {
      try {
        const r = await this.flushOneDb(dbs[i]!, batchSize);
        processed += r.processed;
        failed += r.failed;
      } catch (err) {
        shardErrors.push({ shard: String(i), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { processed, failed, shardErrors };
  }

  /** 单-db flush（原 flush 逻辑，this.tx → 参数 db）。内部逐行 try/catch 不变。 */
  private async flushOneDb(db: SyncWriteUnitOfWork, batchSize: number): Promise<{ processed: number; failed: number }> {
    db.execute(boutboxCmdRequeueStale(this.clock.now() - STALE_PROCESSING_MS));
    const rows = [...db.queryMany(boutboxQueryPending(MAX_ATTEMPTS, batchSize))];
    let processed = 0, failed = 0;
    for (const row of rows) {
      const result = db.execute(boutboxCmdClaim(row.id, this.clock.now()));
      if (result.rowsAffected === 0) continue;
      try {
        await reportUsage(this.config, row.customer_id, row.event_name, row.quantity, row.idempotency_key);
        db.execute(boutboxCmdMarkSent(row.id, this.clock.now()));
        processed++;
        billingMetrics.meterEventsProcessed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        db.execute(boutboxCmdMarkFailed(row.id, errMsg, MAX_ATTEMPTS));
        failed++;
        if (row.attempts + 1 >= MAX_ATTEMPTS) billingMetrics.meterEventsFailed++;
      }
    }
    return { processed, failed };
  }

  pendingCount(): number {
    return this.source.allDbs().reduce((s, db) => s + Number(db.queryOne(boutboxQueryPendingCount())?.count ?? 0), 0);
  }

  failedCount(): number {
    return this.source.allDbs().reduce((s, db) => s + Number(db.queryOne(boutboxQueryFailedCount())?.count ?? 0), 0);
  }
}

export const billingMetrics = {
  meterEventsEnqueued: 0,
  meterEventsProcessed: 0,
  meterEventsFailed: 0,
  meterShardFlushErrors: 0,  // 新增：shard 整体 flush 失败计数（可告警，防坏 shard 静默欠账）
};
```

- [ ] **Step 4: 迁移全部 6 生产构造点（同提交保编译）**

按分类逐一（`tx = db` 均 IDatabase → fromResolver）：
- `memory-facade.ts:105`：`config ? new BillingOutbox(sharedTx, config) : undefined` → `config ? BillingOutbox.fromResolver(new SingleDbResolver(sharedTx), config) : undefined`。
- `life-simulations.ts:42`：`optTx && options?.config ? new BillingOutbox(optTx, options.config) : undefined` → `... ? BillingOutbox.fromResolver(new SingleDbResolver(optTx), options.config) : undefined`。
- `decisions.ts:73`：`new BillingOutbox(sharedTx, config)` → fromResolver。
- `onboarding.ts:77`：同款 → fromResolver。
- `app.ts:448`（别名）：`config.stripe.enabled ? new P1dBillingOutbox(tx, config) : undefined` → `... ? P1dBillingOutbox.fromResolver(new SingleDbResolver(tx), config) : undefined`。
- `app.ts:867`：`new BillingOutbox(tx, config)` → `BillingOutbox.fromResolver(new SingleDbResolver(tx), config)`（**flush 结果处理逻辑留 Task 2**，本步只迁移构造）。
- import `SingleDbResolver` 到各文件（按目录深度）。

- [ ] **Step 5: 迁移测试构造点 + 改 billing-uow-entrance.test.ts**

`billing-uow-entrance.test.ts:41/42/51/73` 的 `new BillingOutbox(db, config)` → `BillingOutbox.fromUnitOfWork(db, config)`。

- [ ] **Step 6: typecheck 权威无残留 + build + 测试绿**

Run:
```bash
npm run typecheck 2>&1 | grep -c "error TS"
npm run build >/dev/null 2>&1; echo "build=$?"
node --test --test-force-exit dist/test/unit/billing-uow-entrance.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0（含别名 :448 已迁移）；build 0；billing-uow-entrance 绿。

- [ ] **Step 7: 提交**

```bash
git add src/billing/billing-outbox.ts src/core/memory-facade.ts src/server/routes/life-simulations.ts src/server/routes/decisions.ts src/server/routes/onboarding.ts src/server/app.ts src/test/unit/billing-uow-entrance.test.ts
git commit -m "$(printf 'feat(billing): BillingOutbox 双入口 + async fan-out 逐 shard 隔离\n\n私有构造器 + fromResolver/fromUnitOfWork + OutboxSource(forTenant+allDbs)。enqueue→\nforTenant；flush 提取 flushOneDb 单-db 逻辑，外层顺序 await 逐 shard try/catch 隔离\n（某 shard 挂不拖累其他，记 shardErrors{shard,error}）；pendingCount/failedCount fan-out\n求和。加 meterShardFlushErrors 计数。全部 6 构造点原子迁移（含 app.ts:448 别名）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: 定时器接线处理 shardErrors（app.ts:867）

**Files:**
- Modify: `src/server/app.ts`（:867 附近定时器的 flush 结果处理）

**Interfaces:**
- Consumes: Task 1 的 `flush(): Promise<FlushResult>`、`billingMetrics`。
- Produces: 定时器在 flush **resolve** 后处理 shardErrors（warn 每个 + 累加 meterShardFlushErrors）。

- [ ] **Step 1: 改定时器 flush 结果处理**

`app.ts:867` 定时器现为 `void billingOutbox.flush().catch((err) => logger.warn(...))`。改为处理 resolved-result（shardErrors 在正常 resolve 时返回，`.catch()` 抓不到）：

```ts
const flushTimer = setInterval(() => {
  void billingOutbox.flush().then((result) => {
    if (result.shardErrors.length > 0) {
      for (const e of result.shardErrors) {
        deps.os.getLogger().warn('Billing', `计量发件箱 shard ${e.shard} flush 失败: ${e.error}`);
      }
      billingMetrics.meterShardFlushErrors += result.shardErrors.length;
    }
  }).catch((err) => {
    deps.os.getLogger().warn('Billing', `计量发件箱刷新失败: ${err instanceof Error ? err.message : String(err)}`);
  });
}, FLUSH_INTERVAL_MS);
```
（import `billingMetrics` from billing-outbox。保留 `.catch()` 防非隔离的意外抛。）

- [ ] **Step 2: typecheck + build**

Run: `npm run typecheck 2>&1 | grep -c "error TS"; npm run build >/dev/null 2>&1; echo "build=$?"`
Expected: typecheck 0；build 0。

- [ ] **Step 3: 提交**

```bash
git add src/server/app.ts
git commit -m "$(printf 'feat(billing): 定时器处理 flush shardErrors（resolved-result + 告警计数）\n\nshardErrors 在 flush 正常 resolve 时返回，.catch() 抓不到——改 .then() 处理：\nwarn 每个挂掉的 shard + 累加 meterShardFlushErrors（防坏 shard 静默欠账）。\n保留 .catch() 防非隔离意外抛。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: 探针测试（6 类 + 2 变异）

**Files:**
- Create: `src/test/unit/billing-outbox-sharding.test.ts`

**Interfaces:**
- Consumes: `BillingOutbox.fromResolver`/`fromUnitOfWork`、`FakeMultiShardResolver`、`SingleDbResolver`、`createMemoryDatabase`+`runDslSqliteMigrations`。

- [ ] **Step 1: 写探针（6 类）**

创建 `src/test/unit/billing-outbox-sharding.test.ts`。**config 无 stripe.secretKey**（reportUsage 抛→markFailed；失败路径验 fan-out/隔离遍历，不碰真 Stripe）。helper `obxDb()`=createMemoryDatabase+runDslSqliteMigrations；`stubConfig`=最小 AppConfig（stripe.enabled 可 true 但无 secretKey）。

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BillingOutbox } from '../../billing/billing-outbox.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

function obxDb(): IDatabase { const db = createMemoryDatabase(); runDslSqliteMigrations(db); return db; }
/* 最小 config——stripe 无 secretKey，reportUsage 会抛（失败路径），探针据此验遍历/隔离。 */
const cfg = { stripe: { enabled: true, secretKey: '' } /* + 其余 AppConfig 必填字段，核对 schema 补齐 */ } as unknown as import('../../config/schema.js').AppConfig;

describe('BillingOutbox 分片探针', () => {
  it('1. enqueue per-tenant 分流对称', () => {
    const s1 = obxDb(), s2 = obxDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'mA');
    ob.enqueue('tB', 'cus_B', 'llm_tokens', 20, 'mB');
    /* 对称：tA 落 s1、tB 落 s2（各 shard 单独查 pendingCount=1，交叉查=0） */
    assert.equal(BillingOutbox.fromUnitOfWork(s1, cfg).pendingCount(), 1, 's1 有 1 条（tA）');
    assert.equal(BillingOutbox.fromUnitOfWork(s2, cfg).pendingCount(), 1, 's2 有 1 条（tB）');
    /* 直接查行确认是各自 tenant（防两条都落 s1 的 bug——用 SQL 查 tenant_id） */
    const s1Tenant = (s1.prepare('SELECT tenant_id FROM billing_outbox').get() as { tenant_id: string }).tenant_id;
    const s2Tenant = (s2.prepare('SELECT tenant_id FROM billing_outbox').get() as { tenant_id: string }).tenant_id;
    assert.equal(s1Tenant, 'tA'); assert.equal(s2Tenant, 'tB');
  });

  it('2. flush fan-out（失败路径证遍历所有 shard）', async () => {
    const s1 = obxDb(), s2 = obxDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'mA');
    ob.enqueue('tB', 'cus_B', 'llm_tokens', 20, 'mB');
    const res = await ob.flush();  // 无 stripe key → 每行 reportUsage 抛 → markFailed
    assert.equal(res.failed, 2, 'fan-out 访问两 shard 各 markFailed 1（若只 flush 单 shard failed=1）');
    assert.equal(res.shardErrors.length, 0, '两 shard 本身未整体抛（是逐行 Stripe 失败非 shard 挂）');
  });

  it('3. shard 整体隔离（核心）', async () => {
    const s1 = obxDb(), s3 = obxDb();
    const bad = throwingDb();  // execute 抛的最小 IDatabase 桩
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, bad, c: s3 }, tenantToShard: { tA: 'a', tC: 'c' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'mA');  // 落 s1
    ob.enqueue('tC', 'cus_C', 'llm_tokens', 30, 'mC');  // 落 s3
    const res = await ob.flush();
    assert.equal(res.shardErrors.length, 1, '仅坏 shard 记 error');
    assert.equal(res.shardErrors[0]!.shard, '1', 'shard 索引身份=1（allDbs 第 2 个 bad）');
    /* 其余 shard 仍被 flush：s1/s3 的行首次失败回 pending、attempts+1、last_error 非空（markFailed CASE：attempts 0→1<5 → pending） */
    const s1Row = s1.prepare('SELECT attempts, last_error, status FROM billing_outbox').get() as { attempts: number; last_error: string | null; status: string };
    assert.equal(s1Row.attempts, 1, 's1 行被处理过（attempts+1）');
    assert.ok(s1Row.last_error, 's1 行 last_error 非空');
    assert.equal(s1Row.status, 'pending', '首次失败回 pending（非 failed）');
  });

  it('4. pendingCount/failedCount fan-out 求和', () => {
    const s1 = obxDb(), s2 = obxDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'e', 1, 'mA'); ob.enqueue('tB', 'cus_B', 'e', 1, 'mB');
    assert.equal(ob.pendingCount(), 2, '两 shard pending 求和');
  });

  it('5. UoW 模式：单 db、flush 遍历一次', async () => {
    const db = obxDb();
    const ob = BillingOutbox.fromUnitOfWork(db, cfg);
    ob.enqueue('t', 'cus', 'e', 1, 'm');
    assert.equal(ob.pendingCount(), 1);
    const res = await ob.flush();
    assert.equal(res.failed, 1, '单 db flush');
    assert.equal(res.shardErrors.length, 0);
  });

  it('6. 单库零回归：SingleDbResolver 等价', async () => {
    const db = obxDb();
    const ob = BillingOutbox.fromResolver(new SingleDbResolver(db), cfg);
    assert.equal(ob.enqueue('t', 'cus', 'e', 1, 'm'), true);
    assert.equal(ob.pendingCount(), 1);
    const res = await ob.flush();
    assert.equal(res.failed, 1);
    assert.equal(res.shardErrors.length, 0);
  });
});
```

实现者补 `throwingDb()`（execute 抛 `Error('boom')`、其余 no-op 的最小 IDatabase 桩，同前片款）+ 核对 `cfg` 的 AppConfig 必填字段补齐（用现有测试的 config helper 若有，或最小构造）。核对 billing_outbox 表列名（tenant_id/customer_id/event_name/quantity/idempotency_key/status/attempts/last_error/created_at/processed_at）。

- [ ] **Step 2: 跑确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/billing-outbox-sharding.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 6/6 绿。

- [ ] **Step 3: 变异证明（2 个，不提交变异）**

- 变异 A（fan-out）：改 billing-outbox.ts flush 只 `dbs[0]`（不遍历）→ 重 build 跑 → 探针 2「fan-out」应红（failed=1 非 2）+ 探针 4 应红。`git checkout` 还原。
- 变异 B（隔离）：改 flush 的 catch 为 `throw err`（fail-fast 非隔离）→ 重 build 跑 → 探针 3「shard 隔离」应红（整体抛，其余 shard 未 flush）。`git checkout` 还原。
每次还原后重 build 确认 6/6 绿、git diff 干净。变异结果写进 report。

- [ ] **Step 4: 提交**

```bash
git add src/test/unit/billing-outbox-sharding.test.ts
git commit -m "$(printf 'test(billing): BillingOutbox 分片探针（enqueue 分流 + flush fan-out 隔离 + count 求和）\n\n6 类：enqueue 对称分流 / flush 失败路径证遍历所有 shard / shard 整体隔离（bad shard\n记 shardErrors 其余仍 flush，首次失败回 pending）/ count fan-out 求和 / UoW / 零回归。\n失败路径不碰真 Stripe。2 变异（fan-out 只碰首 db、隔离改 rethrow）各红对应探针。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: 全量回归 + ratchet 验证（纯验证）

> 构造点已在 Task 1 原子迁移。本任务全仓验证。

**Files:** 无预期改动。

- [ ] **Step 1: 无残留（typecheck 权威 + grep）**

Run:
```bash
npm run typecheck 2>&1 | grep -c "error TS"
grep -rn "new BillingOutbox(\|new P1dBillingOutbox(" src --include="*.ts" | grep -v "src/billing/billing-outbox.ts" && echo "!!!外部残留" || echo "外部零残留"
```
Expected: tc 0；外部零残留（仅类内两工厂合法）。

- [ ] **Step 2: 全量 unit 回归**

Run:
```bash
npm run build >/dev/null 2>&1; echo "build=$?"
node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|suites|pass|fail)"
```
Expected: build 0；**全量 unit fail=0**（baseline 本片前 2113）。

- [ ] **Step 3: ratchet 不变**

Run: `node scripts/check-db-access-ratchet.mjs; echo "ratchet=$?"`
Expected: exit 0，26 条不变。

- [ ] **Step 4: 集成点验（billing 相关集成测试）**

Run: `node --test --test-force-exit dist/test/integration/billing-api.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 全绿（PG 相关若无 PG 则 SKIP）。

- [ ] **Step 5: 无提交（纯验证）或补记**

---

## Self-Review

**1. Spec coverage**：
- 双入口 + OutboxSource + flushOneDb 提取 + flush 逐 shard 隔离 + count fan-out + FlushResult + meterShardFlushErrors → Task 1。✓
- 定时器 resolved-result 处理 shardErrors → Task 2。✓
- 6 类探针 + 2 变异 → Task 3。✓
- 6 构造点原子迁移（含 :448 别名）→ Task 1。✓
- 零回归/ratchet → Task 4。✓

**2. Placeholder scan**：探针 `cfg` 的 AppConfig 必填字段、throwingDb、billing_outbox 列名标注了「核对/补齐」——有意核对指令。无 TBD。

**3. Type consistency**：`FlushResult {processed, failed, shardErrors:{shard,error}[]}` 在 Task 1 定义，Task 2 定时器 + Task 3 探针一致解构；`OutboxSource {forTenant, allDbs}` Task 1 内联；工厂签名 `fromResolver(resolver, config, clock?)` 一致。

**4. 编译原子性**：Task 1 私有化 + 全部 6 构造点同提交迁移（Step 4/5），每提交编译过。Task 2（定时器行为）建立在 Task 1 已迁移基础（:867 构造已 fromResolver，Task 2 只改 flush 结果处理）。Task 3/4 后续。

**注意点（实现者）：**
- **别名 :448 P1dBillingOutbox 易漏**——Task 1 Step 6 typecheck 必须 0（grep 抓不到别名）。
- markFailed 首次失败回 pending（CASE attempts+1>=maxAttempts）——探针 3 断 attempts+1/last_error/status=pending，别断 failed。
- 探针失败路径验 fan-out 遍历，非 Stripe 成功路径（成功路径 processed 聚合未覆盖，spec 已记录风险）。
- flushOneDb 是 async（内含 await reportUsage），flush 外层顺序 await。
