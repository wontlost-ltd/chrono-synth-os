/**
 * QuotaManager 多-shard 分片探针（Phase 0「子服务 resolver 模式」子片验收）。
 * 用 FakeMultiShardResolver 注多个独立物理内存 db，断言分片路由分流正确——
 * 「铺路不激活」子片唯一能真正验证正确性的手段：单库下 dbForTenant 与
 * coordinatorDb 是同一 db，普通功能测试证不出路由对错。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { throwingDb } from '../support/throwing-db.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 quota 表的内存 db（迁移入口——runDslSqliteMigrations 建全表）。 */
function quotaDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 直接向 quota_usage 插入 n 行旧窗口数据（window_start 远早于任何探针用的 cutoff）。 */
function seedOldUsage(db: IDatabase, n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      'INSERT INTO quota_usage (tenant_id, resource, used, window_start) VALUES (?, ?, ?, ?)',
    ).run(`seed-tenant-${i}`, 'seed-resource', 1, 1000 + i);
  }
}


describe('QuotaManager 分片探针', () => {
  it('1. per-tenant 分流：写真落 dbForTenant 对应 shard', () => {
    const s1 = quotaDb(), s2 = quotaDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const qm = QuotaManager.fromResolver(r);
    qm.setLimit('tA', 'sim', 5, 60_000);
    qm.setLimit('tB', 'sim', 9, 60_000);
    const aOnS1 = s1.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('tA', 'sim') as { m: number } | undefined;
    const aOnS2 = s2.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('tA', 'sim') as { m: number } | undefined;
    assert.equal(aOnS1?.m, 5, 'tA 落 s1');
    assert.equal(aOnS2, undefined, 'tA 不在 s2');
    const bOnS2 = s2.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('tB', 'sim') as { m: number } | undefined;
    assert.equal(bOnS2?.m, 9, 'tB 落 s2');
  });

  it('2. fan-out：prune 跑遍所有 shard，totalDeleted 为各 shard 之和', () => {
    const s1 = quotaDb(), s2 = quotaDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const qm = QuotaManager.fromResolver(r);
    /* 各 shard 预置旧窗口 usage 行（用 recordUsage 在很早的 now 写，制造旧窗口）。 */
    qm.setLimit('tA', 'sim', 100, 1000); qm.consumeQuota('tA', 'sim', 1, 1_000);   // 落 s1，windowStart≈1000
    qm.setLimit('tB', 'sim', 100, 1000); qm.consumeQuota('tB', 'sim', 1, 1_000);   // 落 s2
    /* now 远大于旧窗口 + cutoff 覆盖旧窗口 → 两 shard 各删 1 行。 */
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 2, '两 shard 各删 1');
    assert.equal(res.mayHaveMore, false);
  });

  it('3. fan-out 去重：allShardDbs 唯一 → 同库不重复 prune', () => {
    const shared = quotaDb();
    /* 两 shardId 指向同一实例（模拟同 connStr）。FakeMultiShardResolver.allShardDbs 按实例去重 → 只 prune 一次。 */
    const r = new FakeMultiShardResolver({ coordinator: shared, shards: { a: shared, b: shared }, tenantToShard: { t: 'a' } });
    const qm = QuotaManager.fromResolver(r);
    qm.setLimit('t', 'sim', 100, 1000); qm.consumeQuota('t', 'sim', 1, 1_000);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 1, '同库只删一次（非 2）');
  });

  it('4. mayHaveMore 分页信号', () => {
    const s1 = quotaDb(), s2 = quotaDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: {} });
    const qm = QuotaManager.fromResolver(r);
    /* s1 预置 >= batchSize 行旧窗口，s2 少量。batchSize=1 → s1 删 1 就 removed>=1=batchSize → mayHaveMore。 */
    seedOldUsage(s1, 2);  // helper：直接 INSERT 2 行旧窗口到 quota_usage
    seedOldUsage(s2, 0);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1);  // batchSize=1
    assert.equal(res.mayHaveMore, true, 's1 删满一批 → 还有');
  });

  it('5. fan-out fail-fast：中途 shard 抛错 → 整体抛错 + s1 已部分执行 + 后续 shard 未执行；换掉坏 shard 后重试收敛', () => {
    const s1 = quotaDb(), s3 = quotaDb();
    /* bad 是会抛错的 db 桩（execute 抛）。三 shard 顺序 a→bad→c。 */
    const bad = throwingDb({ on: 'execute' });
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, bad: bad, c: s3 }, tenantToShard: {} });
    const qm = QuotaManager.fromResolver(r);
    seedOldUsage(s1, 1);
    seedOldUsage(s3, 1);
    const s1Before = (s1.prepare('SELECT COUNT(*) AS c FROM quota_usage').get() as { c: number }).c;
    assert.equal(s1Before, 1, '前置：s1 初始 1 行旧窗口');
    assert.throws(() => qm.pruneUsageBefore(10_000_000, 9_000_000, 1000), /boom/);
    /* s1 已删（fail-fast 前 s1 排在 bad 之前，本轮已执行）——断言行数比初始减少。 */
    const s1After = (s1.prepare('SELECT COUNT(*) AS c FROM quota_usage').get() as { c: number }).c;
    assert.ok(s1After < s1Before, 's1 在抛错前已被部分/全部删除（fail-fast 前置执行）');
    /* s3 本轮未执行（bad 在 s3 之前抛）——观测 s3 旧行仍在。 */
    const s3Remaining = (s3.prepare('SELECT COUNT(*) AS c FROM quota_usage').get() as { c: number }).c;
    assert.equal(s3Remaining, 1, 's3 本轮未被触碰（后续 shard 不跑）');

    /* 幂等重试收敛：把 bad 换成正常 db（同一物理 s1/s3，模拟「故障 shard 恢复」后重试）。
       prune 对旧窗口行是幂等的（已删的不会再删、未删的补删）——重试应不抛错且最终全清空。 */
    const recovered = quotaDb();
    const rRetry = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, bad: recovered, c: s3 }, tenantToShard: {} });
    const qmRetry = QuotaManager.fromResolver(rRetry);
    const retryRes = qmRetry.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(retryRes.mayHaveMore, false, '重试收敛：本批已清空，无需再分页');
    const s1Final = (s1.prepare('SELECT COUNT(*) AS c FROM quota_usage').get() as { c: number }).c;
    const s3Final = (s3.prepare('SELECT COUNT(*) AS c FROM quota_usage').get() as { c: number }).c;
    assert.equal(s1Final, 0, '重试后 s1 旧行清空');
    assert.equal(s3Final, 0, '重试后 s3 旧行清空（首轮未执行的部分被追上）');
  });

  it('6. UoW 模式：固定 tx、prune 单次不 fan-out', () => {
    const db = quotaDb();
    const qm = QuotaManager.fromUnitOfWork(db);
    qm.setLimit('t', 'sim', 3, 60_000);
    const row = db.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('t', 'sim') as { m: number };
    assert.equal(row.m, 3);
    seedOldUsage(db, 1);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 1);
  });

  it('7. 单库零回归：SingleDbResolver 行为等价单库', () => {
    const db = quotaDb();
    const qm = QuotaManager.fromResolver(new SingleDbResolver(db));
    qm.setLimit('t', 'sim', 4, 60_000);
    assert.equal(qm.checkQuota('t', 'sim', 1, 1_000), true);
    seedOldUsage(db, 1);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 1);
    assert.equal(res.mayHaveMore, false);
  });
});
