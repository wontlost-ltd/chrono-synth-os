import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShardRouter } from '../../storage/shard-router.js';
import { shardIdForTenant } from '../../storage/shard-hash.js';
import { createMemoryDatabase } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 每个 connStr 建一个独立内存 db,记录 close 次数（验幂等/不双关）——同 shard-router.test.ts 的既有 fake 模式。 */
function trackingBuild() {
  const built = new Map<string, IDatabase>();
  const closes = new Map<string, number>();
  const buildDb = (connStr: string): IDatabase => {
    if (!built.has(connStr)) {
      const db = createMemoryDatabase();
      const origClose = db.close.bind(db);
      (db as { close: () => void }).close = () => { closes.set(connStr, (closes.get(connStr) ?? 0) + 1); origClose(); };
      built.set(connStr, db);
    }
    return built.get(connStr)!;
  };
  return { buildDb, built, closes };
}

/** 造一个可计 close 次数的 fake IDatabase（供 seedDbs 传入，代表外部已建好的 db）。 */
function fakeSeedDb(): { db: IDatabase; closeCount: () => number } {
  let closeCount = 0;
  const db = {
    close: () => { closeCount += 1; },
    prepare: () => { throw new Error('测试未用：seed db 不该被查询'); },
    exec: () => { throw new Error('测试未用：seed db 不该被查询'); },
    transaction: () => { throw new Error('测试未用：seed db 不该被查询'); },
    migrate: () => { throw new Error('测试未用：seed db 不该被查询'); },
  } as unknown as IDatabase;
  return { db, closeCount: () => closeCount };
}

describe('ShardRouter.seedDbs（borrowed/owned close ownership）', () => {
  it('① borrowed seed：close() 后 seed db close 计数 == 0（外部拥有,router 不关）', () => {
    const { buildDb } = trackingBuild();
    const seed = fakeSeedDb();
    const r = new ShardRouter({
      shards: { s1: 'c1', s2: 'c2' },
      homeShardId: 's1',
      seedDbs: { c1: seed.db },
      buildDb,
    });
    r.dbForTenant('default'); // 触发 s1(=c1) 访问,应直接拿 seed 实例,不调 buildDb
    r.close();
    assert.equal(seed.closeCount(), 0, 'seed 的 db 是 borrowed,close() 不应关它');
  });

  it('② owned（buildDb 建的）：close 计数 == 1', () => {
    const { buildDb, closes } = trackingBuild();
    const seed = fakeSeedDb();
    const r = new ShardRouter({
      shards: { s1: 'c1', s2: 'c2' },
      homeShardId: 's1',
      seedDbs: { c1: seed.db },
      buildDb,
    });
    r.initialize();
    r.close();
    assert.equal(closes.get('c2'), 1, 'c2 是 buildDb 建的（owned）,应被关恰一次');
    assert.equal(seed.closeCount(), 0, 'c1 是 borrowed,不关');
  });

  it('③ initialize() 中途某 buildDb 抛 → 已建 owned 被回收（close 1）,borrowed seed 不关（0）', () => {
    const seed = fakeSeedDb();
    const closedOwned: string[] = [];
    const buildDb = (connStr: string): IDatabase => {
      if (connStr === 'c3') throw new Error('boom');
      const db = createMemoryDatabase();
      (db as { close: () => void }).close = () => { closedOwned.push(connStr); };
      return db;
    };
    const r = new ShardRouter({
      shards: { s1: 'c1', s2: 'c2', s3: 'c3' },
      homeShardId: 's1',
      seedDbs: { c1: seed.db },
      buildDb,
    });
    assert.throws(() => r.initialize(), /boom/);
    assert.deepEqual(closedOwned, ['c2'], '已建的 owned c2 被回收,不半泄漏');
    assert.equal(seed.closeCount(), 0, 'borrowed 的 c1 不应被 initialize 失败回收逻辑关闭');
  });

  it('④ coordinator connStr == 某 shard connStr 且都 seed → 只一个实例、不重复关', () => {
    const seed = fakeSeedDb();
    const { buildDb } = trackingBuild();
    const r = new ShardRouter({
      shards: { s1: 'c1', s2: 'c2' },
      homeShardId: 's1',
      coordinatorConnStr: 'c1',
      seedDbs: { c1: seed.db },
      buildDb,
    });
    assert.strictEqual(r.dbForTenant('default'), r.coordinatorDb(), 'coordinator 与 home shard 共享同一 seed 实例');
    r.close();
    assert.equal(seed.closeCount(), 0, '共享的 seed 实例不应被关（borrowed）,且不重复关');
  });

  it('⑤ close 幂等（二次 close 不重复关）——owned 与 borrowed 均验', () => {
    const { buildDb, closes } = trackingBuild();
    const seed = fakeSeedDb();
    const r = new ShardRouter({
      shards: { s1: 'c1', s2: 'c2' },
      homeShardId: 's1',
      seedDbs: { c1: seed.db },
      buildDb,
    });
    r.initialize();
    r.close();
    r.close(); // 幂等
    assert.equal(closes.get('c2'), 1, 'owned c2 只关一次');
    assert.equal(seed.closeCount(), 0, 'borrowed c1 始终不关');
  });

  it('⑥ 非 home shard 且 buildDb 抛 → dbForTenant 该 shard fail-closed（抛）', () => {
    const seed = fakeSeedDb();
    const buildDb = (connStr: string): IDatabase => {
      if (connStr === 'c2') throw new Error('shard s2 建库失败');
      return createMemoryDatabase();
    };
    const r = new ShardRouter({
      shards: { s1: 'c1', s2: 'c2' },
      homeShardId: 's1',
      seedDbs: { c1: seed.db },
      buildDb,
    });
    /* s1(=c1) 是 seed,借用不抛;s2(=c2) 未 seed,访问时懒建触发 buildDb 抛错 → fail-closed。
       用 shardIdForTenant 找一个真落 s2 的 tenantId（同 shard-router.test.ts 的既有找法）。 */
    const ids = ['s1', 's2'];
    let tenantOnS2: string | undefined;
    for (let i = 0; i < 1000 && !tenantOnS2; i++) {
      const t = `t${i}`;
      if (shardIdForTenant(t, ids) === 's2') tenantOnS2 = t;
    }
    assert.ok(tenantOnS2, '应能找到一个落 s2 的 tenantId');
    assert.throws(() => r.dbForTenant(tenantOnS2!), /建库失败/, '非 home shard 懒建失败 → fail-closed 抛出,不静默返回');
  });
});
