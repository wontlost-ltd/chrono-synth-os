import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations, MIGRATIONS } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';

describe('版本化迁移系统', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  it('首次运行创建 schema_migrations 表和所有业务表', () => {
    runMigrations(db);

    /* 通过查询各表验证存在性（不依赖 sqlite_master 系统表） */
    const migrations = db.prepare<{ version: string }>('SELECT version FROM schema_migrations').all();
    assert.ok(migrations.length > 0, 'schema_migrations 表应存在');

    const values = db.prepare<{ id: string }>('SELECT id FROM core_values LIMIT 0').all();
    assert.ok(Array.isArray(values), 'core_values 表应存在');

    const memories = db.prepare<{ id: string }>('SELECT id FROM memory_nodes LIMIT 0').all();
    assert.ok(Array.isArray(memories), 'memory_nodes 表应存在');

    const personas = db.prepare<{ id: string }>('SELECT id FROM persona_versions LIMIT 0').all();
    assert.ok(Array.isArray(personas), 'persona_versions 表应存在');

    const snapshots = db.prepare<{ id: string }>('SELECT id FROM snapshots LIMIT 0').all();
    assert.ok(Array.isArray(snapshots), 'snapshots 表应存在');
  });

  it('记录已应用的迁移版本', () => {
    runMigrations(db);
    const rows = db.prepare<{ version: string; description: string }>(
      'SELECT version, description FROM schema_migrations ORDER BY version',
    ).all();

    assert.equal(rows.length, MIGRATIONS.length);
    assert.equal(rows[0].version, 'v001');
    assert.equal(rows[0].description, '初始表结构');
  });

  it('重复执行幂等：不会重新应用已有迁移', () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    const rows = db.prepare<{ version: string }>(
      'SELECT version FROM schema_migrations',
    ).all();
    assert.equal(rows.length, MIGRATIONS.length);
  });

  it('已有数据的库再次迁移不丢失数据', () => {
    runMigrations(db);

    db.prepare<void>(
      'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
    ).run('v1', 'test-value', 0.5, 1000);

    runMigrations(db);

    const row = db.prepare<{ id: string }>('SELECT id FROM core_values WHERE id = ?').get('v1');
    assert.ok(row);
    assert.equal(row.id, 'v1');
  });

  it('MIGRATIONS 数组按版本排序', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      assert.ok(MIGRATIONS[i].version > MIGRATIONS[i - 1].version,
        `迁移 ${MIGRATIONS[i].version} 应在 ${MIGRATIONS[i - 1].version} 之后`);
    }
  });
});
