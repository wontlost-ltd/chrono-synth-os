import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { CompanionMoodStore } from '../../storage/companion-mood-store.js';
import { DEFAULT_MOOD } from '../../conversation/mood.js';
import type { IDatabase } from '../../storage/database.js';

/* ADR-0056 心情 store——get/set round-trip + 默认 + 范围夹 + 租户隔离。 */
describe('CompanionMoodStore（ADR-0056 情绪）', () => {
  let db: IDatabase;
  let store: CompanionMoodStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new CompanionMoodStore(db, 'tenant-a', 'default');
  });

  it('无 row → DEFAULT_MOOD（updatedAt=null）', () => {
    const { mood, updatedAt } = store.get();
    assert.deepEqual(mood, DEFAULT_MOOD);
    assert.equal(updatedAt, null);
  });

  it('set → get round-trip', () => {
    store.set({ valence: 0.5, arousal: 0.7 }, 2000);
    const { mood, updatedAt } = store.get();
    assert.equal(mood.valence, 0.5);
    assert.equal(mood.arousal, 0.7);
    assert.equal(updatedAt, 2000);
  });

  it('落库范围夹（脏数据 valence>1 / arousal<0 → 夹回）', () => {
    store.set({ valence: 5, arousal: -2 }, 2000);
    const { mood } = store.get();
    assert.ok(mood.valence <= 1 && mood.arousal >= 0);
  });

  it('租户隔离：A 的心情 B 看不到', () => {
    store.set({ valence: 0.8, arousal: 0.6 }, 2000);
    const storeB = new CompanionMoodStore(db, 'tenant-b', 'default');
    assert.deepEqual(storeB.get().mood, DEFAULT_MOOD, 'B 租户用默认');
  });

  /* 回归（E2E 暴露的 PG bug）：Postgres 把 bigint updated_at 返回为 string，旧实现 typeof==='number'
   * 判定会误判为 null → elapsedMs 恒 0 → 心情时间回归在 PG 上静默失效。断言 string-bigint 被强转。 */
  it('PG bigint 返回 string → updatedAt 被强转为 number', () => {
    const pgRow = { valence: 0.5, arousal: 0.7, updated_at: '432001000' };
    const fakeDb = { prepare: () => ({ get: () => pgRow }) } as unknown as IDatabase;
    const { updatedAt } = new CompanionMoodStore(fakeDb, 'tenant-a', 'default').get();
    assert.strictEqual(updatedAt, 432001000, 'updated_at string→number');
  });

  it('updated_at 为 null → 保留 null（不被 Number(null)=0 污染）', () => {
    const pgRow = { valence: 0, arousal: 0.3, updated_at: null };
    const fakeDb = { prepare: () => ({ get: () => pgRow }) } as unknown as IDatabase;
    const { updatedAt } = new CompanionMoodStore(fakeDb, 'tenant-a', 'default').get();
    assert.strictEqual(updatedAt, null);
  });
});
