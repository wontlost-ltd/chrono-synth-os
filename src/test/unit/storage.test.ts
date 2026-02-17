import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations, mapToJson, jsonToMap, arrayToJson, jsonToArray } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';

describe('serialization', () => {
  it('Map 往返序列化', () => {
    const original = new Map([['a', 1], ['b', 2]]);
    const json = mapToJson(original);
    const restored = jsonToMap<number>(json);
    assert.deepEqual(restored, original);
  });

  it('数组往返序列化', () => {
    const original = ['x', 'y', 'z'];
    const json = arrayToJson(original);
    const restored = jsonToArray<string>(json);
    assert.deepEqual(restored, original);
  });
});

describe('SqliteDatabase', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
  });

  it('migrations 创建所有表', () => {
    const expectedTables = [
      'core_values', 'memory_nodes', 'memory_edges', 'narrative',
      'persona_versions', 'conflicts', 'snapshots', 'evolution_records',
    ];
    for (const table of expectedTables) {
      const row = db.prepare<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
      assert.ok(row !== undefined, `表 ${table} 应存在`);
    }
  });

  it('prepare.run 返回 changes', () => {
    const result = db.prepare('INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)')
      .run('v1', 'test', 0.5, 1000);
    assert.equal(result.changes, 1);
  });

  it('prepare.get 返回行或 undefined', () => {
    db.prepare('INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)')
      .run('v1', 'test', 0.5, 1000);
    const row = db.prepare<{ id: string }>('SELECT id FROM core_values WHERE id = ?').get('v1');
    assert.equal(row?.id, 'v1');
    const missing = db.prepare<{ id: string }>('SELECT id FROM core_values WHERE id = ?').get('nope');
    assert.equal(missing, undefined);
  });

  it('transaction 成功时提交', () => {
    db.transaction(() => {
      db.prepare('INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)')
        .run('v1', 'test', 0.5, 1000);
      db.prepare('INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)')
        .run('v2', 'test2', 0.6, 1000);
    });
    const rows = db.prepare<{ id: string }>('SELECT id FROM core_values').all();
    assert.equal(rows.length, 2);
  });

  it('transaction 异常时回滚', () => {
    assert.throws(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)')
          .run('v1', 'test', 0.5, 1000);
        throw new Error('模拟失败');
      });
    });
    const rows = db.prepare<{ id: string }>('SELECT id FROM core_values').all();
    assert.equal(rows.length, 0);
  });
});
