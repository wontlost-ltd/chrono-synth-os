/**
 * PostgreSQL 集成测试
 * 需要 TEST_POSTGRES_URL 环境变量指向可用的 PostgreSQL 实例
 * 跳过条件：未设置 TEST_POSTGRES_URL 时自动跳过
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TenantDatabase } from '../../multi-tenant/tenant-database.js';
import { createIsolatedPgSchema } from './fixtures/pg-test-schema.js';

const TEST_URL = process.env.TEST_POSTGRES_URL;

describe('PostgreSQL 集成测试', { skip: !TEST_URL }, () => {
  /* 延迟导入，避免在没有 pg 依赖时报错 */
  let PostgresDatabase: typeof import('../../storage/postgres-database.js').PostgresDatabase;
  let db: InstanceType<typeof PostgresDatabase>;
  let cleanup: () => Promise<void>;

  before(async () => {
    /* 每文件独立 schema 隔离（修 pre-existing flaky）：CI 把集成测试并行子进程跑且共享同一 PG 库，
     * 多文件同时重置 public schema 会撞（pg_type duplicate / 残留表 ADD COLUMN already-exists）。
     * helper 给本文件专属 schema，迁移/读写经 search_path 全落其中，与并行文件互不可见。 */
    const iso = await createIsolatedPgSchema('postgres', TEST_URL!);
    db = iso.db;
    cleanup = iso.cleanup;
  });

  after(async () => {
    if (cleanup) await cleanup();
  });

  it('迁移成功创建所有表', () => {
    const rows = db.prepare<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all();
    assert.ok(rows.length >= 3, '应至少有 3 个迁移版本');
    assert.equal(rows[0].version, 'v001');
  });

  it('CRUD: core_values', () => {
    db.prepare<void>(
      `INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, weight=excluded.weight, updated_at=excluded.updated_at`,
    ).run('test-val-1', '诚实', 0.8, Date.now());

    const row = db.prepare<{ id: string; label: string; weight: number }>(
      'SELECT id, label, weight FROM core_values WHERE id = ?',
    ).get('test-val-1');

    assert.ok(row);
    assert.equal(row.id, 'test-val-1');
    assert.equal(row.label, '诚实');
    assert.equal(row.weight, 0.8);

    /* 清理 */
    db.prepare<void>('DELETE FROM core_values WHERE id = ?').run('test-val-1');
  });

  it('事务：成功提交', () => {
    db.transaction(() => {
      db.prepare<void>(
        'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
      ).run('tx-val-1', '勇气', 0.7, Date.now());
    });

    const row = db.prepare<{ id: string }>('SELECT id FROM core_values WHERE id = ?').get('tx-val-1');
    assert.ok(row);

    db.prepare<void>('DELETE FROM core_values WHERE id = ?').run('tx-val-1');
  });

  it('事务：异常回滚', () => {
    try {
      db.transaction(() => {
        db.prepare<void>(
          'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
        ).run('tx-val-rollback', '测试', 0.5, Date.now());
        throw new Error('故意失败');
      });
    } catch { /* 预期 */ }

    const row = db.prepare<{ id: string }>('SELECT id FROM core_values WHERE id = ?').get('tx-val-rollback');
    assert.equal(row, undefined, '回滚后数据不应存在');
  });

  it('TenantDatabase 可正确处理带 LIMIT/OFFSET 的分页查询', () => {
    const now = Date.now();
    db.prepare<void>(
      `INSERT INTO memory_nodes (
        id, tenant_id, kind, content, valence, salience,
        created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem_pg_a1', 'tenant-a', 'episodic', 'tenant a memory 1', 0.2, 0.9, now - 1000, now - 1000, 0, 0.0001, now - 1000, null);
    db.prepare<void>(
      `INSERT INTO memory_nodes (
        id, tenant_id, kind, content, valence, salience,
        created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem_pg_a2', 'tenant-a', 'episodic', 'tenant a memory 2', 0.1, 0.8, now, now, 0, 0.0001, now, null);
    db.prepare<void>(
      `INSERT INTO memory_nodes (
        id, tenant_id, kind, content, valence, salience,
        created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem_pg_b1', 'tenant-b', 'episodic', 'tenant b memory', 0.3, 0.7, now + 1000, now + 1000, 0, 0.0001, now + 1000, null);

    const tenantDb = new TenantDatabase(db, 'tenant-a');
    const rows = tenantDb.prepare<{ id: string }>(
      'SELECT id FROM memory_nodes ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(1, 0);

    assert.deepEqual(rows.map((row) => row.id), ['mem_pg_a2']);
  });

  it('占位符转换正确', async () => {
    const { convertPlaceholders } = await import('../../storage/postgres-database.js');
    /* 基本替换 */
    assert.equal(convertPlaceholders('SELECT ? WHERE id = ?'), 'SELECT $1 WHERE id = $2');
    assert.equal(convertPlaceholders('SELECT 1'), 'SELECT 1');

    /* 单引号字符串内的 ? 不替换 */
    assert.equal(convertPlaceholders("INSERT INTO t (v) VALUES ('?')"), "INSERT INTO t (v) VALUES ('?')");

    /* 标准 SQL '' 转义 */
    assert.equal(convertPlaceholders("SELECT 'it''s ?' WHERE x = ?"), "SELECT 'it''s ?' WHERE x = $1");

    /* 双引号标识符内的 ? 不替换 */
    assert.equal(convertPlaceholders('SELECT "col?" FROM t WHERE id = ?'), 'SELECT "col?" FROM t WHERE id = $1');

    /* 行注释内的 ? 不替换 */
    assert.equal(convertPlaceholders('SELECT ? -- comment ?\nWHERE x = ?'), 'SELECT $1 -- comment ?\nWHERE x = $2');

    /* 块注释内的 ? 不替换 */
    assert.equal(convertPlaceholders('SELECT ? /* comment ? */ WHERE x = ?'), 'SELECT $1 /* comment ? */ WHERE x = $2');

    /* 美元引号内的 ? 不替换 */
    assert.equal(convertPlaceholders('SELECT $$hello ? world$$ WHERE id = ?'), 'SELECT $$hello ? world$$ WHERE id = $1');

    /* JSONB 运算符 ?| ?& 保留 */
    assert.equal(convertPlaceholders("SELECT data ?| array['a'] WHERE id = ?"), "SELECT data ?| array['a'] WHERE id = $1");
    assert.equal(convertPlaceholders("SELECT data ?& array['a'] WHERE id = ?"), "SELECT data ?& array['a'] WHERE id = $1");
  });
});
