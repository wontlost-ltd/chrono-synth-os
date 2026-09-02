/**
 * BillingOutbox 多-shard 分片探针（「BillingOutbox 双入口化」子片第 3 任务验收）。
 * 用 FakeMultiShardResolver 注多个独立物理内存 db，断言：
 * enqueue 按 tenantId 分流 + flush 异步 fan-out 逐 shard 隔离 + count fan-out 求和。
 * 「铺路不激活」子片唯一能真正验证正确性的手段：单库下 dbForTenant 与 coordinatorDb 是同一 db，
 * 普通功能测试证不出路由对错；本探针注独立 db，让「数据真落对 shard」可断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BillingOutbox } from '../../billing/billing-outbox.js';
import { boutboxCmdClaim } from '@chrono/kernel';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { loadConfig } from '../../config/schema.js';
import { throwingDb } from '../support/throwing-db.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 billing_outbox 表的内存 db（迁移入口——runDslSqliteMigrations 建全表）。 */
function obxDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/*
 * 最小 config：stripe.enabled=true 但无 secretKey → flush 时 reportUsage 抛错 → markFailed。
 * 复用现有 billing 测试的建法（loadConfig({}) 默认无 stripe.secretKey），不碰真 Stripe，
 * 恰好是探针需要的失败路径：验 fan-out 遍历所有 shard、shard 整体隔离时其余 shard 仍被处理。
 */
const cfg = loadConfig({});

describe('BillingOutbox 分片探针', () => {
  it('1. enqueue per-tenant 分流对称', () => {
    const s1 = obxDb(), s2 = obxDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'mA');
    ob.enqueue('tB', 'cus_B', 'llm_tokens', 20, 'mB');
    /* 对称断言：tA 落 s1、tB 落 s2（各 shard 单独查 pendingCount=1，防两条都落 s1 的 bug）。 */
    assert.equal(BillingOutbox.fromUnitOfWork(s1, cfg).pendingCount(), 1, 's1 有 1 条（tA）');
    assert.equal(BillingOutbox.fromUnitOfWork(s2, cfg).pendingCount(), 1, 's2 有 1 条（tB）');
    /* 直接查行确认 tenant_id 是各自租户（对称，非仅数量相符）。 */
    const s1Tenant = (s1.prepare('SELECT tenant_id FROM billing_outbox').get() as { tenant_id: string }).tenant_id;
    const s2Tenant = (s2.prepare('SELECT tenant_id FROM billing_outbox').get() as { tenant_id: string }).tenant_id;
    assert.equal(s1Tenant, 'tA', 's1 落的是 tA 的行');
    assert.equal(s2Tenant, 'tB', 's2 落的是 tB 的行');
  });

  it('2. flush fan-out（失败路径证遍历所有 shard）', async () => {
    const s1 = obxDb(), s2 = obxDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'mA');
    ob.enqueue('tB', 'cus_B', 'llm_tokens', 20, 'mB');
    const res = await ob.flush(); // 无 stripe secretKey → 每行 reportUsage 抛 → markFailed
    assert.equal(res.failed, 2, 'fan-out 访问两 shard 各 markFailed 1（若只 flush 单 shard failed=1）');
    assert.equal(res.shardErrors.length, 0, '两 shard 本身未整体抛（是逐行 Stripe 失败，非 shard 挂）');
  });

  it('3. shard 整体隔离（核心）：坏 shard 记 error，其余 shard 仍被 flush', async () => {
    const s1 = obxDb(), s3 = obxDb();
    const bad = throwingDb({ on: 'execute' });
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, bad, c: s3 }, tenantToShard: { tA: 'a', tC: 'c' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'mA'); // 落 s1
    ob.enqueue('tC', 'cus_C', 'llm_tokens', 30, 'mC'); // 落 s3
    const res = await ob.flush();
    /* 不整体抛（await 正常返回，未 throw）+ 仅坏 shard 记 error。 */
    assert.equal(res.shardErrors.length, 1, '仅坏 shard 记 error（其余 shard 不受牵连）');
    assert.equal(res.shardErrors[0]!.shard, '1', 'shard 索引身份=1（allShardDbs 顺序第 2 个是 bad）');
    /* 其余 shard 仍被 flush：s1/s3 的行首次失败回 pending（markFailed CASE：attempts 0→1<5→pending），
       attempts+1、last_error 非空——证明坏 shard 没有拖累其他 shard 的处理。 */
    const s1Row = s1.prepare('SELECT attempts, last_error, status FROM billing_outbox').get() as { attempts: number; last_error: string | null; status: string };
    assert.equal(s1Row.attempts, 1, 's1 行被处理过（attempts+1）');
    assert.ok(s1Row.last_error, 's1 行 last_error 非空');
    assert.equal(s1Row.status, 'pending', '首次失败回 pending（非 failed，未到 maxAttempts）');
    const s3Row = s3.prepare('SELECT attempts, last_error, status FROM billing_outbox').get() as { attempts: number; last_error: string | null; status: string };
    assert.equal(s3Row.attempts, 1, 's3 行也被处理过（坏 shard 在其前面也不影响）');
    assert.ok(s3Row.last_error, 's3 行 last_error 非空');
    assert.equal(s3Row.status, 'pending', 's3 首次失败同样回 pending');
  });

  it('4. pendingCount/failedCount fan-out 求和', () => {
    const s1 = obxDb(), s2 = obxDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ob = BillingOutbox.fromResolver(r, cfg);
    ob.enqueue('tA', 'cus_A', 'e', 1, 'mA');
    ob.enqueue('tB', 'cus_B', 'e', 1, 'mB');
    assert.equal(ob.pendingCount(), 2, '两 shard pending 求和（非单 shard 的 1）');
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

  it('6. 单库零回归：SingleDbResolver 行为等价单库', async () => {
    const db = obxDb();
    const ob = BillingOutbox.fromResolver(new SingleDbResolver(db), cfg);
    assert.equal(ob.enqueue('t', 'cus', 'e', 1, 'm'), true);
    assert.equal(ob.pendingCount(), 1);
    const res = await ob.flush();
    assert.equal(res.failed, 1);
    assert.equal(res.shardErrors.length, 0);
  });

  /* ── issue #393：stale 判定必须由数据库单一时钟裁决 ─────────────── */

  /**
   * 缺陷（与 observability outbox #380 同型）：认领方写自己的 `Date.now()` 进 `processed_at`，
   * 回收方用自己的 `Date.now() - STALE_PROCESSING_MS` 算截止点。
   *
   * 多进程前提**已核实成立**：`billing_outbox` 的 flush 定时器跑在 **API 进程内**
   * （`app.ts:1013` 的 60s setInterval，全仓唯一 flush 调用点，无独立 billing worker），
   * 而 `k8s/deployment.yml` replicas:2、`k8s/production/deployment.yml` replicas:3
   * —— 多副本各自认领/回收同一张 Postgres 表。
   *
   * 实测（修复前）：B 比 A 快 0/4 分钟 → processing；快 6/10 分钟 → **pending**
   * ＝ 正在处理中的行被回收 → 重发 Stripe。
   * （严重度 Low：`idempotency_key` 是**持久化列**，enqueue 时写入、回收不重算，
   * 故重发在 Stripe 侧收敛。注意依据是**列持久化**而非派生逻辑稳定 ——
   * 无 sourceId 时走 `tenant:event:clock:seq` 派生，重算必然不同。）
   *
   * ⚠️ 本组用例必须走 **`ob.flush()` 真实生产路径**，不能直接调 kernel 命令。
   * 初版就是直接调 `boutboxCmdRequeueStale`，结果把生产调用点
   * （`billing-outbox.ts:119`）回退成旧语义后，**全套 2723 测试仍全绿** ——
   * 那正是本 PR 声称要防的 #381 型回归，却留在零覆盖的调用点上（独立审查实测拆穿）。
   */
  it('★回归★ flush 会回收卡住的行（生产调用点，非直调 kernel 命令）', async () => {
    const db = obxDb();
    const ob = BillingOutbox.fromUnitOfWork(db, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'src_stuck');
    const id = db.prepare<{ id: number }>('SELECT id FROM billing_outbox').all()[0]!.id;
    /* 模拟消费者崩溃：卡在 processing 10 分钟（> STALE_PROCESSING_MS 5min）。 */
    db.prepare<void>("UPDATE billing_outbox SET status='processing', processed_at=? WHERE id=?")
      .run(Date.now() - 10 * 60 * 1000, id);

    await ob.flush();

    /* cfg 无 stripe.secretKey → reportUsage 抛错 → markFailed；关键是它**被回收并重试过**，
     * 而不是永远停在 processing。回退成绝对截止点时此处恒为 'processing'（实测）。 */
    const st = db.prepare<{ status: string }>('SELECT status FROM billing_outbox WHERE id=?')
      .all(id)[0]?.status;
    assert.notEqual(st, 'processing',
      '卡住的行必须被 flush 回收（回退成应用侧截止点时会永远停在 processing）');
  });

  it('★回归★ flush 不得回收刚认领的行', async () => {
    /* ⚠️ 对照：只断言「能回收」会被「全部回收」蒙混过关。
     * 这里让行处于 processing 且**刚刚**被 DB 盖戳，flush 不得把它收走。 */
    const db = obxDb();
    const ob = BillingOutbox.fromUnitOfWork(db, cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'src_fresh');
    const id = db.prepare<{ id: number }>('SELECT id FROM billing_outbox').all()[0]!.id;
    db.prepare<void>(
      "UPDATE billing_outbox SET status='processing', processed_at=(CAST(strftime('%s','now') AS INTEGER)*1000) WHERE id=?",
    ).run(id);

    await ob.flush();

    const st = db.prepare<{ status: string }>('SELECT status FROM billing_outbox WHERE id=?')
      .all(id)[0]?.status;
    assert.equal(st, 'processing', '刚认领的行不得被回收（否则 stale 窗口形同虚设）');
  });

  it('★回归★ 认领 API **在结构上**不接受调用方时间（不是靠数值容差）', () => {
    /* ⚠️ 初版这条断言 `|dbNow - processed_at| <= 2000`，是**重言式**：
     * 单机上应用 `Date.now()` 与 DB 时钟本就相差几十毫秒，把认领侧整个回退成
     * 应用时钟后该断言照样通过（独立审查实测：|diff|=178ms，9/9 全绿）。
     * 它测的是「本机两个时钟一致」——恒真，且**不是**被测性质。
     *
     * 正确的判据是**结构性**的：认领命令的 params 里根本没有时间字段，
     * 调用方**没有任何入口**注入自己的时刻。一旦有人给 BoutboxClaimParams
     * 加回 `now`（哪怕带默认值），本断言立刻转红。 */
    const cmd = boutboxCmdClaim(1);
    const keys = Object.keys(cmd.params).sort();
    assert.deepEqual(keys, ['id'],
      `认领命令不得携带任何时间参数（实际字段：${keys.join(', ')}）——`
      + '时间必须由数据库盖戳，否则跨副本钟差会平移 stale 判定');
  });

  /* ── 认领 CAS：多副本重复计费的唯一防线 ──
   *
   * `boutboxCmdClaim` 的 `AND status = 'pending'` 是**唯一**阻止两个 API 副本
   * 同时认领同一行的东西。认领重复 ⇒ 两副本各自 `reportUsage` ⇒ **重复的
   * Stripe 计量事件 = 真实多收客户钱**。
   *
   * k8s/deployment.yml 是 `replicas: 2`（生产 3），且 app.ts **无 leader
   * election** —— flush 定时器在每个副本里都跑，所以这是实况不是假设
   * （executor 里的注释也写着「API replicas:2 两副本各自认领同一张表」）。
   *
   * ⚠️ 此前**零覆盖**：把 `AND status = 'pending'` 去掉后，全量 4113 条测试
   * （2795 单元 + 1318 集成）**全绿**。既有用例只断言「第一次认领成功」，
   * 从不验证第二次必须失败 —— 而失败那一侧才是防线本身。 */
  it('★认领 CAS：同一行只能被认领一次（防多副本重复计费）★', () => {
    const db = obxDb();
    const ob = BillingOutbox.fromResolver(new SingleDbResolver(db), cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'idem-A');

    /* ⚠️ 别按 'idem-A' 查：enqueue 的第 5 参是 **sourceId**，实际落库的
     * idempotency_key 是 `${tenantId}:${eventName}:${sourceId}`。
     * 直接取唯一那一行，避免复刻拼 key 的规则（复刻= 断言自己的副本）。 */
    const row = db.prepare<{ id: number }>(
      `SELECT id FROM billing_outbox ORDER BY id LIMIT 1`,
    ).get();
    assert.ok(row, '前置：入队应落库');

    /* 副本 1 认领 —— 应成功。 */
    const first = db.execute(boutboxCmdClaim(row.id));
    assert.equal(first.rowsAffected, 1, '第一次认领必须成功');

    /* 副本 2 认领**同一行** —— 必须失败（status 已是 processing）。
     * 变异实测：把 `AND status = 'pending'` 去掉 → 本行变 1，转红。 */
    const second = db.execute(boutboxCmdClaim(row.id));
    assert.equal(second.rowsAffected, 0, '第二次认领必须失败，否则两副本会各报一次 Stripe 计量');

    /* 状态没被第二次认领改坏（processed_at 不应被重新盖戳）。 */
    const after = db.prepare<{ status: string }>(
      `SELECT status FROM billing_outbox WHERE id = ?`,
    ).get(row.id);
    assert.equal(after?.status, 'processing');
  });

  /* 对照：认领**未被占用**的行仍应成功 —— 防止「把认领整个关掉」也算绿。 */
  it('对照：不同行各自可被认领（修复不是把认领关掉）', () => {
    const db = obxDb();
    const ob = BillingOutbox.fromResolver(new SingleDbResolver(db), cfg);
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 10, 'idem-1');
    ob.enqueue('tA', 'cus_A', 'llm_tokens', 20, 'idem-2');

    const rows = db.prepare<{ id: number }>(
      `SELECT id FROM billing_outbox ORDER BY id`,
    ).all();
    assert.equal(rows.length, 2, '前置：两条待处理');

    assert.equal(db.execute(boutboxCmdClaim(rows[0].id)).rowsAffected, 1);
    assert.equal(db.execute(boutboxCmdClaim(rows[1].id)).rowsAffected, 1, '另一行不受影响');
  });
});
