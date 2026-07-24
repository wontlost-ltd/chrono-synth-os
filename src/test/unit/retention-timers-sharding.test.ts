/**
 * Retention/cleanup timer 多-shard 分片探针（分片 Phase 0 · Plan 2 · Task 4）。
 *
 * 三处「周期性清理」原本只在**当前 tx / 单个 db** 上跑，多 shard 部署下会漏清非-home shard 的数据：
 *  ① ToolInvocationsRetentionWorker：ctor 从收 ToolPermissionService 改收 TenantDbResolver，flushOnce
 *     遍历 allShardDbs() 各 new ToolPermissionService(shardDb).pruneInvocationsBefore；只跑一库则其余
 *     shard 的 tool_invocations 永不回收。
 *  ② cleanupExpiredTokens（routes/auth.ts route helper）：从收单 db 改收 resolver fan-out——refresh_token
 *     现落**用户所在 shard**（AuthService.generateTokenPair 经 dbForTenant 写），旧 coordinatorDb-only 清理
 *     会漏掉非-coordinator shard 的过期 token（真 bug：token 落 shard 但只清 coordinator）。
 *  ③ runDataRetentionOnce：跨租户表（usage_records/billing_outbox/idempotency_keys）经 allShardDbs() fan-out；
 *     webhook_events（平台表无 tenant_id）经 coordinatorDb()。
 *
 * 三处都逐 shard try/catch 隔离 + 失败不静默（shardErrors 收集，坏 shard 不拖累好 shard）。
 * 单库下 allShardDbs()=[db]、coordinatorDb()=同一 db，「非-home shard 漏清」测不出——多 shard 布置是唯一
 * 能让「只跑一库」与「fan-out 全 shard」产生可观测差异的手段。
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { ToolInvocationsRetentionWorker } from '../../agent/tool-invocations-retention-worker.js';
import { cleanupExpiredTokens } from '../../server/routes/auth.js';
import { runDataRetentionOnce } from '../../server/app.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { throwingDb } from '../support/throwing-db.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { SilentLogger } from '../../utils/logger.js';
import { authCmdCreateRefreshToken, authCmdCreateUser } from '@chrono/kernel';
import type { IDatabase } from '../../storage/database.js';

/** 建带全表的内存 db（一个 db = 一个 shard）。 */
function shardDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 在指定 shard 上登记一条「已过期」的 tool_invocation（invoked_at 远早于 cutoff）。 */
function seedExpiredInvocation(db: IDatabase, tenantId: string, hash: string): string {
  const svc = new ToolPermissionService(db);
  return svc.recordInvocation({
    tenantId, personaId: 'p1', toolId: 'web_search',
    invokerType: 'mcp', invokerId: 'c', invokerUserId: 'u',
    status: 'success', inputHash: hash, outputSizeBytes: 0, errorMessage: null,
    costCents: 0, durationMs: 0, confirmationTokenId: null,
    invokedAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
  });
}

/**
 * 在指定 shard 上直接落一条**已过期**的 refresh_token（模拟 generateTokenPair 经 dbForTenant 写该 shard）。
 * 先建 user 满足 refresh_tokens.user_id FK。
 */
function seedExpiredRefreshToken(db: IDatabase, id: string, userId: string, tokenHash: string): void {
  const now = Date.now();
  db.execute(authCmdCreateUser({
    id: userId, email: `${userId}@t.test`, passwordHash: 'x', role: 'admin', tenantId: 'default', now,
  }));
  db.execute(authCmdCreateRefreshToken({
    id, userId, tokenHash,
    expiresAt: now - 40 * 24 * 60 * 60 * 1000, /* 早于 cleanupExpired 的 30 天 cutoff */
    now: now - 60 * 24 * 60 * 60 * 1000,
  }));
}

describe('ToolInvocationsRetentionWorker 分片探针（allShardDbs fan-out）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = shardDb();
    s1 = shardDb();
  });

  it('① fan-out：两 shard 各 seed 过期 invocation → flushOnce 两 shard 都清（聚合=两之和）', async () => {
    const idA = seedExpiredInvocation(s0, 'tenant_a', 'hA');
    const idB = seedExpiredInvocation(s1, 'tenant_b', 'hB');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const worker = new ToolInvocationsRetentionWorker(resolver, new SilentLogger(), {
      batchSize: 100, maxBatchesPerCycle: 5,
    });

    const result = await worker.flushOnce();

    assert.equal(result.deleted, 2, '两 shard 过期 invocation 之和');
    assert.equal(result.shardErrors.length, 0);
    /* 两 shard 的过期行都被删（只跑 home 则会漏 s1）。 */
    assert.equal(new ToolPermissionService(s0).getInvocation('tenant_a', idA), null, 's0 过期行已删');
    assert.equal(new ToolPermissionService(s1).getInvocation('tenant_b', idB), null, 's1 过期行已删（fan-out 必要）');
  });

  it('② shard 抛错隔离：坏 shard（throwingDb execute 抛）记 shardErrors、好 shard 仍清', async () => {
    const idA = seedExpiredInvocation(s0, 'tenant_a', 'hA');
    /* pruneInvocationsBefore 内部走 tx.execute(tinvCmdPruneBefore) → throwingDb({on:'execute'}) 抛。 */
    const bad = throwingDb({ on: 'execute' });
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const logger = new SilentLogger();
    const worker = new ToolInvocationsRetentionWorker(resolver, logger, {
      batchSize: 100, maxBatchesPerCycle: 5,
    });

    const result = await worker.flushOnce();

    assert.equal(result.deleted, 1, 's0 仍清（坏 shard 不拖累）');
    assert.equal(new ToolPermissionService(s0).getInvocation('tenant_a', idA), null, 's0 过期行已删');
    assert.equal(result.shardErrors.length, 1, '坏 shard 记 shardErrors');
    assert.match(result.shardErrors[0]!.error, /boom/);
    assert.ok(logger.entries.some((e) => e.level === 'error'), '坏 shard 记 error 级日志（不静默）');
  });

  it('单库零回归：SingleDbResolver 等价（跳 pending、只清过期）', async () => {
    const db = shardDb();
    const oldId = seedExpiredInvocation(db, 'default', 'hOld');
    const worker = new ToolInvocationsRetentionWorker(new SingleDbResolver(db), new SilentLogger(), {
      batchSize: 100, maxBatchesPerCycle: 5,
    });
    const result = await worker.flushOnce();
    assert.equal(result.deleted, 1);
    assert.equal(new ToolPermissionService(db).getInvocation('default', oldId), null);
  });
});

describe('cleanupExpiredTokens 分片探针（route helper resolver fan-out）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = shardDb();
    s1 = shardDb();
  });

  it('① refresh_token 落 s1 过期 → cleanupExpiredTokens(resolver) 清 s1；旧 coordinatorDb-only 会漏 s1', () => {
    /* token 落 s1（非 coordinator=s0），模拟 generateTokenPair 经 dbForTenant 写用户所在 shard。 */
    seedExpiredRefreshToken(s1, 'rt_s1', 'u_s1', 'hash_s1');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });

    /* 旧行为（coordinatorDb-only）会漏 s1：证 fan-out 必要——仅传 coordinator=s0 清不到落在 s1 的 token。 */
    const coordinatorOnly = cleanupExpiredTokens(new SingleDbResolver(s0), new SilentLogger());
    assert.equal(coordinatorOnly.total, 0, '仅清 coordinator(s0) 清不到落 s1 的 token（旧 bug）');
    assert.ok(tokenExists(s1, 'hash_s1'), 's1 token 仍在（coordinatorDb-only 漏清）');

    /* fan-out：resolver 覆盖 s0+s1 → s1 的过期 token 被清。 */
    const result = cleanupExpiredTokens(resolver, new SilentLogger());
    assert.equal(result.total, 1, 'fan-out 清到 s1 的过期 token');
    assert.equal(result.shardErrors.length, 0);
    assert.ok(!tokenExists(s1, 'hash_s1'), 's1 过期 token 已清（fan-out 必要）');
  });

  it('② shard 抛错隔离 + 不静默：坏 shard 记 shardErrors + logger.error、好 shard 仍清', () => {
    seedExpiredRefreshToken(s0, 'rt_s0', 'u_s0', 'hash_s0');
    const bad = throwingDb({ on: 'execute' }); /* cleanupExpired 走 tx.execute(authCmdCleanupExpiredTokens) → 抛 */
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const logger = new SilentLogger();

    const result = cleanupExpiredTokens(resolver, logger);

    assert.equal(result.total, 1, 's0 仍清（坏 shard 不拖累）');
    assert.ok(!tokenExists(s0, 'hash_s0'), 's0 过期 token 已清');
    assert.equal(result.shardErrors.length, 1, '坏 shard 记 shardErrors');
    assert.match(result.shardErrors[0]!.error, /boom/);
    assert.ok(logger.entries.some((e) => e.level === 'error'), '坏 shard 记 error 级日志（失败不静默）');
  });
});

describe('runDataRetentionOnce 分片探针（跨租户表 fan-out + webhook coordinatorDb）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = shardDb();
    s1 = shardDb();
  });

  const RETENTION_MS = {
    usage: 90 * 24 * 60 * 60 * 1000,
    billing: 30 * 24 * 60 * 60 * 1000,
    idempotency: 0,
    webhook: 7 * 24 * 60 * 60 * 1000,
  };

  /** 直接落一条过期 usage_records（recorded_at 远早于 now-usage）。 */
  function seedUsage(db: IDatabase, id: string, tenantId: string, recordedAt: number): void {
    db.prepare('INSERT INTO usage_records (id, tenant_id, resource, quantity, recorded_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tenantId, 'sim', 1, recordedAt);
  }
  /** 落一条已发送(sent)且 processed_at 过期的 billing_outbox 行。 */
  function seedBilling(db: IDatabase, tenantId: string, processedAt: number): void {
    db.prepare(
      'INSERT INTO billing_outbox (tenant_id, customer_id, event_name, quantity, idempotency_key, status, created_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(tenantId, 'cus', 'evt', 1, `idem_${tenantId}_${processedAt}`, 'sent', processedAt, processedAt);
  }
  /** 落一条已过期 idempotency_keys 行。 */
  function seedIdempotency(db: IDatabase, id: string, tenantId: string, expiresAt: number): void {
    db.prepare(
      'INSERT INTO idempotency_keys (id, tenant_id, scope_key, idempotency_key, request_hash, request_method, request_path, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, tenantId, 'scope', id, 'rh', 'POST', '/x', 'completed', expiresAt, expiresAt);
  }
  /** 落一条 processed_at 过期的 webhook_events（平台表无 tenant_id）。 */
  function seedWebhook(db: IDatabase, eventId: string, processedAt: number): void {
    db.prepare('INSERT INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)')
      .run(eventId, 'invoice.paid', processedAt);
  }
  function count(db: IDatabase, table: string): number {
    return Number((db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  }

  it('① 跨租户表两 shard 都清 + webhook 只在 coordinator 清', () => {
    const now = Date.now();
    const old = now - 200 * 24 * 60 * 60 * 1000;
    /* usage/billing/idempotency 各 shard 各一条过期行。 */
    seedUsage(s0, 'ur0', 'ta', old); seedUsage(s1, 'ur1', 'tb', old);
    seedBilling(s0, 'ta', old); seedBilling(s1, 'tb', old);
    seedIdempotency(s0, 'ik0', 'ta', old); seedIdempotency(s1, 'ik1', 'tb', old);
    /* webhook 只在 coordinator（=s0）seed（平台表无 tenant_id，不 fan-out）。 */
    seedWebhook(s0, 'wh0', old);

    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { ta: 'shard0', tb: 'shard1' },
    });

    const r = runDataRetentionOnce({ resolver, now, retentionMs: RETENTION_MS });

    assert.equal(r.usageDeleted, 2, 'usage 两 shard 之和');
    assert.equal(r.billingDeleted, 2, 'billing 两 shard 之和');
    assert.equal(r.idempotencyDeleted, 2, 'idempotency 两 shard 之和');
    assert.equal(r.webhookDeleted, 1, 'webhook 只在 coordinator 清');
    assert.equal(r.shardErrors.length, 0);
    /* 两 shard 的跨租户表都清空。 */
    assert.equal(count(s0, 'usage_records'), 0); assert.equal(count(s1, 'usage_records'), 0, 's1 也清（fan-out 必要）');
    assert.equal(count(s0, 'billing_outbox'), 0); assert.equal(count(s1, 'billing_outbox'), 0);
    assert.equal(count(s0, 'idempotency_keys'), 0); assert.equal(count(s1, 'idempotency_keys'), 0);
    assert.equal(count(s0, 'webhook_events'), 0, 'coordinator webhook 清');
  });

  it('② shard 抛错隔离：throwingDb 作 s1 → shardErrors 含 s1、s0 仍清', () => {
    const now = Date.now();
    const old = now - 200 * 24 * 60 * 60 * 1000;
    seedUsage(s0, 'ur0', 'ta', old);
    seedWebhook(s0, 'wh0', old);
    /* prepare 抛：runDataRetentionOnce 逐 shard 用 db.prepare(...).all/run → throwingDb({on:'prepare'}) 抛。 */
    const bad = throwingDb({ on: 'prepare' });
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { ta: 'shard0', tb: 'shard1' },
    });

    const r = runDataRetentionOnce({ resolver, now, retentionMs: RETENTION_MS });

    assert.equal(r.usageDeleted, 1, 's0 仍清');
    assert.equal(count(s0, 'usage_records'), 0, 's0 过期行已清');
    assert.equal(r.webhookDeleted, 1, 'webhook 在 coordinator=s0 清（不受坏 shard 影响）');
    assert.ok(r.shardErrors.length >= 1, '坏 shard 记 shardErrors');
    assert.ok(r.shardErrors.some((e) => /boom/.test(e.error)), 'shardErrors 含坏 shard 的错误');
  });

  it('单库零回归：SingleDbResolver 等价（四表都清、无 shardErrors）', () => {
    const db = shardDb();
    const now = Date.now();
    const old = now - 200 * 24 * 60 * 60 * 1000;
    seedUsage(db, 'ur', 't', old);
    seedBilling(db, 't', old);
    seedIdempotency(db, 'ik', 't', old);
    seedWebhook(db, 'wh', old);

    const r = runDataRetentionOnce({ resolver: new SingleDbResolver(db), now, retentionMs: RETENTION_MS });

    assert.equal(r.usageDeleted, 1);
    assert.equal(r.billingDeleted, 1);
    assert.equal(r.idempotencyDeleted, 1);
    assert.equal(r.webhookDeleted, 1);
    assert.equal(r.shardErrors.length, 0);
  });
});

/** 探测某 shard 上是否存在指定 hash 的 refresh_token（未撤销/已撤销均计）。 */
function tokenExists(db: IDatabase, tokenHash: string): boolean {
  const row = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as { n: number } | undefined;
  return (row ? Number(row.n) : 0) > 0;
}
