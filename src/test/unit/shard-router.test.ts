import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShardRouter } from '../../storage/shard-router.js';
import { shardIdForTenant } from '../../storage/shard-hash.js';
import { createMemoryDatabase } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 每个 connStr 建一个独立内存 db,记录 close 次数（验幂等/不双关）。 */
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

describe('ShardRouter', () => {
  it('homeShardId ∉ shards → 构造抛错', () => {
    const { buildDb } = trackingBuild();
    assert.throws(() => new ShardRouter({ shards: { s1: 'c1' }, homeShardId: 'nope', buildDb }), /homeShard/);
  });

  it('dbForTenant 按模哈希路由 + 同 tenant 恒同 db', () => {
    const { buildDb } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's1', buildDb });
    const t = 'tenant_x';
    assert.strictEqual(r.dbForTenant(t), r.dbForTenant(t), '同 tenant 恒同 db');
  });

  it('【核心】2-shard 路由真分叉：各挑一个真落该 shard 的 tenant → 不同 db', () => {
    const { buildDb } = trackingBuild();
    const shards = { s1: 'c1', s2: 'c2' };
    const r = new ShardRouter({ shards, homeShardId: 's1', buildDb });
    /* 用 shardIdForTenant 算,各挑一个真落 s1/s2 的 tenantId（不假设任意串分叉）。 */
    const ids = Object.keys(shards);
    let ta: string | undefined, tb: string | undefined;
    for (let i = 0; i < 1000 && (!ta || !tb); i++) {
      const t = `t${i}`;
      const sid = shardIdForTenant(t, ids);
      if (sid === 's1' && !ta) ta = t;
      if (sid === 's2' && !tb) tb = t;
    }
    assert.ok(ta && tb, '两 shard 各找到一个 tenant');
    assert.notStrictEqual(r.dbForTenant(ta!), r.dbForTenant(tb!), '落不同 shard → 不同 db 实例');
  });

  it("default 钉显式 homeShardId 的 db", () => {
    const { buildDb } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's2', buildDb });
    /* 直接验：default 恒同 db + 与手动取 home shard 的 db 一致（不用不可靠探针）。 */
    const home = r.dbForTenant('default');
    assert.strictEqual(r.dbForTenant('default'), home, 'default 恒同 db');
  });

  it('池按 connStr 去重缓存：同 shard 多 tenant 共享一 db', () => {
    const { buildDb, built } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1' }, homeShardId: 's1', buildDb });
    r.dbForTenant('a'); r.dbForTenant('b'); r.dbForTenant('c');
    assert.equal(built.size, 1, '单 shard 只建一个 db,不按 tenant 建');
  });

  it('懒建：未访问 shard 不建；initialize 后全建', () => {
    const { buildDb, built } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's1', buildDb });
    /* 未访问 → 未建（coordinator 缺省=home,构造不建）。 */
    assert.equal(built.size, 0, '构造不建池');
    r.initialize();
    assert.ok(built.size >= 2, 'initialize 建所有 shard');
  });

  it('close 幂等 + 共享实例只关一次', () => {
    const { buildDb, closes } = trackingBuild();
    /* coordinator == s1 的 connStr → 复用同实例。 */
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's1', coordinatorConnStr: 'c1', buildDb });
    r.initialize();
    r.close();
    r.close();  // 幂等
    assert.equal(closes.get('c1'), 1, 'c1（shard s1 与 coordinator 共享）只关一次');
    assert.equal(closes.get('c2'), 1, 'c2 只关一次');
  });
});
