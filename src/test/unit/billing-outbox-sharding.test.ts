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
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { loadConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 billing_outbox 表的内存 db（迁移入口——runDslSqliteMigrations 建全表）。 */
function obxDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 最小 IDatabase 桩：execute 恒抛错，其余方法 no-op（只用于 shard 整体隔离探针）。 */
function throwingDb(): IDatabase {
  return {
    dialect: 'sqlite',
    exec: () => {},
    prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
    transaction: (fn: () => unknown) => fn(),
    transactionRollback: (fn: () => unknown) => fn(),
    close: () => {},
    queryOne: () => null,
    queryMany: () => [],
    execute: () => { throw new Error('boom'); },
  } as unknown as IDatabase;
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
    const bad = throwingDb();
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
});
