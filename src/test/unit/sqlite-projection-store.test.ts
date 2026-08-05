/**
 * 单元测试：SqliteProjectionStore 的版本单调性。
 *
 * 背景（审计 Warning B5-6 + Codex 交叉审查补口）：write() 原用无条件
 * ON CONFLICT DO UPDATE，事件乱序到达时延迟的 v1 会抹掉已写入的 v2，
 * 读模型静默回退到旧状态且无任何错误可循。本文件锁定「只有更高版本才覆盖」
 * 这一语义——此前 SQLite 实现完全没有对应单测。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteProjectionStore } from '../../data-plane/sqlite-projection-store.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

describe('SqliteProjectionStore — 版本单调', () => {
  let db: IDatabase;
  let store: SqliteProjectionStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new SqliteProjectionStore(db);
  });

  it('更高版本正常覆盖', async () => {
    await store.write('t1', 'proj', 'id-1', { v: 'first' }, 1);
    await store.write('t1', 'proj', 'id-1', { v: 'second' }, 2);
    assert.deepEqual(await store.read('t1', 'proj', 'id-1'), { v: 'second' });
  });

  it('较低版本不得覆盖（乱序到达的旧事件）', async () => {
    await store.write('t1', 'proj', 'id-1', { v: 'v2' }, 2);
    await store.write('t1', 'proj', 'id-1', { v: 'v1-late' }, 1);
    assert.deepEqual(
      await store.read('t1', 'proj', 'id-1'), { v: 'v2' },
      '延迟到达的 v1 不得让读模型回退',
    );
  });

  it('同版本重放不改变状态（幂等）', async () => {
    await store.write('t1', 'proj', 'id-1', { v: 'original' }, 2);
    await store.write('t1', 'proj', 'id-1', { v: 'replayed' }, 2);
    assert.deepEqual(await store.read('t1', 'proj', 'id-1'), { v: 'original' });
  });

  it('租户之间互不影响（同 id 同版本各自独立）', async () => {
    await store.write('t1', 'proj', 'id-1', { who: 't1' }, 5);
    await store.write('t2', 'proj', 'id-1', { who: 't2' }, 1);
    assert.deepEqual(await store.read('t1', 'proj', 'id-1'), { who: 't1' });
    assert.deepEqual(await store.read('t2', 'proj', 'id-1'), { who: 't2' });
  });
});
