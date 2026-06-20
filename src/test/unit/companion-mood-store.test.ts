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
});
