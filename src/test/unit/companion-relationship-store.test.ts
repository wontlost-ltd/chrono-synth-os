import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { CompanionRelationshipStore } from '../../storage/companion-relationship-store.js';
import type { IDatabase } from '../../storage/database.js';

/* ADR-0056 关系 store——互动计数/时间戳/用户名/租户隔离。 */
describe('CompanionRelationshipStore（ADR-0056 关系层）', () => {
  let db: IDatabase;
  let store: CompanionRelationshipStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new CompanionRelationshipStore(db, 'tenant-a', 'default');
  });

  it('无 row → 空关系（count 0, 无名字/时间）', () => {
    const r = store.get();
    assert.equal(r.interactionCount, 0);
    assert.equal(r.userName, undefined);
    assert.equal(r.firstMetAt, null);
  });

  it('recordInteraction：首次设 first_met，每次 ++count、更新 last_seen', () => {
    store.recordInteraction(1000);
    let r = store.get();
    assert.equal(r.interactionCount, 1);
    assert.equal(r.firstMetAt, 1000);
    assert.equal(r.lastSeenAt, 1000);
    store.recordInteraction(2000);
    r = store.get();
    assert.equal(r.interactionCount, 2, '++count');
    assert.equal(r.firstMetAt, 1000, 'first_met 不变');
    assert.equal(r.lastSeenAt, 2000, 'last_seen 更新');
  });

  it('setUserName → get round-trip（不影响计数）', () => {
    store.recordInteraction(1000);
    store.setUserName('小明', 2000);
    const r = store.get();
    assert.equal(r.userName, '小明');
    assert.equal(r.interactionCount, 1, '设名不动计数');
  });

  it('用户名清洗：剥控制字符/markup，空名抛错', () => {
    const saved = store.setUserName('小\n明<b>', 1000);
    assert.equal(saved, '小明b');
    assert.throws(() => store.setUserName('<>', 1000), /为空/);
  });

  it('租户隔离：A 的关系 B 看不到', () => {
    store.recordInteraction(1000);
    store.setUserName('小明', 1000);
    const storeB = new CompanionRelationshipStore(db, 'tenant-b', 'default');
    assert.equal(storeB.get().interactionCount, 0);
    assert.equal(storeB.get().userName, undefined);
  });

  /* 回归（E2E 暴露的 PG bug）：Postgres node-pg 把 bigint 列返回为 **string**，旧实现用
   * typeof==='number' 判定会把时间戳误判为 null → 时间感知（好久不见/认识N天）在 PG 上静默失效。
   * 这里用 fakeDb 模拟 PG 返回的 string-bigint 行，断言 store 用 Number() 强转回数字。 */
  it('PG bigint 返回 string → 时间戳/计数被强转为 number（跨驱动一致）', () => {
    /* interaction_count 也用 string（防御：某些驱动/聚合把数值列以 string 返回）。 */
    const pgRow = { user_name: '小明', interaction_count: '12', first_met_at: '1000', last_seen_at: '432001000' };
    const fakeDb = { prepare: () => ({ get: () => pgRow }) } as unknown as IDatabase;
    const pgStore = new CompanionRelationshipStore(fakeDb, 'tenant-a', 'default');
    const r = pgStore.get();
    assert.strictEqual(r.firstMetAt, 1000, 'first_met_at string→number');
    assert.strictEqual(r.lastSeenAt, 432001000, 'last_seen_at string→number');
    assert.strictEqual(r.interactionCount, 12, 'interaction_count string→number');
  });

  it('时间戳为 null（从未互动）→ 保留 null（不被 Number(null)=0 污染）', () => {
    const pgRow = { user_name: null, interaction_count: 0, first_met_at: null, last_seen_at: null };
    const fakeDb = { prepare: () => ({ get: () => pgRow }) } as unknown as IDatabase;
    const r = new CompanionRelationshipStore(fakeDb, 'tenant-a', 'default').get();
    assert.strictEqual(r.firstMetAt, null);
    assert.strictEqual(r.lastSeenAt, null);
  });
});
