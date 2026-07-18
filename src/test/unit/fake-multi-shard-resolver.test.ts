import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { createMemoryDatabase } from '../../storage/index.js';

describe('FakeMultiShardResolver（验收脚手架）', () => {
  it('dbForTenant 按 tenantId→shard 映射返对应 db；未映射抛错', () => {
    const s1 = createMemoryDatabase();
    const s2 = createMemoryDatabase();
    const coord = createMemoryDatabase();
    const r = new FakeMultiShardResolver({
      coordinator: coord,
      shards: { shardA: s1, shardB: s2 },
      tenantToShard: { t1: 'shardA', t2: 'shardB' },
    });
    assert.strictEqual(r.dbForTenant('t1'), s1);
    assert.strictEqual(r.dbForTenant('t2'), s2);
    assert.strictEqual(r.coordinatorDb(), coord);
    assert.throws(() => r.dbForTenant('unknown'), /映射|未知|unknown/i);
  });

  it('allShardDbs 返唯一 shard db、稳定顺序（与真实 ShardRouter 语义对齐）', () => {
    const s1 = createMemoryDatabase();
    const s2 = createMemoryDatabase();
    const r = new FakeMultiShardResolver({
      coordinator: s1, /* coordinator 复用 s1（同实例）——不应在 allShardDbs 里重复 */
      shards: { shardA: s1, shardB: s2 },
      tenantToShard: {},
    });
    const dbs = r.allShardDbs();
    assert.equal(dbs.length, 2, '两个唯一 shard 实例');
    assert.strictEqual(dbs[0], s1);
    assert.strictEqual(dbs[1], s2);
  });
});
