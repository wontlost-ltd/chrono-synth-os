import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { MemoryTranslationStore } from '../../storage/memory-translation-store.js';
import type { IDatabase } from '../../storage/database.js';

/* ADR-0055 内容多语：记忆翻译变体 store——upsert/get/list + 增量 + 租户隔离。 */
describe('MemoryTranslationStore（ADR-0055 内容多语）', () => {
  let db: IDatabase;
  let store: MemoryTranslationStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    /* 翻译表外键引用 memory_nodes——先建一条记忆。 */
    db.prepare(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, tenant_id)
       VALUES ('m1', 'semantic', '我学过带团队要授权', 0, 0.7, 1000, 1000, 0, 0.0001, 1000, 'tenant-a')`,
    ).run();
    store = new MemoryTranslationStore(db, 'tenant-a');
  });

  it('无变体 → get undefined', () => {
    assert.equal(store.get('m1', 'en'), undefined);
  });

  it('upsert → get round-trip', () => {
    store.upsert('m1', 'en', 'I learned that leading a team means delegating', 2000);
    assert.equal(store.get('m1', 'en'), 'I learned that leading a team means delegating');
  });

  it('upsert 覆盖（重新翻译）', () => {
    store.upsert('m1', 'en', 'old translation', 2000);
    store.upsert('m1', 'en', 'new translation', 3000);
    assert.equal(store.get('m1', 'en'), 'new translation');
  });

  it('listByLanguage → Map<id, text>', () => {
    store.upsert('m1', 'en', 'english variant', 2000);
    const map = store.listByLanguage('en');
    assert.equal(map.get('m1'), 'english variant');
    assert.equal(map.size, 1);
    assert.equal(store.listByLanguage('zh-CN').size, 0, '其他语言无变体');
  });

  it('translatedIds → 已翻译集合（增量翻译用）', () => {
    store.upsert('m1', 'en', 'variant', 2000);
    assert.ok(store.translatedIds('en').has('m1'));
    assert.ok(!store.translatedIds('en').has('m2'));
  });

  it('空文本不落库', () => {
    store.upsert('m1', 'en', '   ', 2000);
    assert.equal(store.get('m1', 'en'), undefined);
  });

  it('租户隔离：A 的变体 B 看不到', () => {
    store.upsert('m1', 'en', 'a-variant', 2000);
    const storeB = new MemoryTranslationStore(db, 'tenant-b');
    assert.equal(storeB.get('m1', 'en'), undefined);
    assert.equal(storeB.listByLanguage('en').size, 0);
  });
});
