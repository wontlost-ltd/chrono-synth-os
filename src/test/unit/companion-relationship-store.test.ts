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
});
