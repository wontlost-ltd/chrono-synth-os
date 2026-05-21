import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantDatabase } from '../../multi-tenant/tenant-database.js';
import type { IDatabase, IPreparedStatement, SqlValue } from '../../storage/database.js';

describe('TenantDatabase', () => {
  let baseDb: IDatabase;

  beforeEach(() => {
    baseDb = createMemoryDatabase();
    runDslSqliteMigrations(baseDb);
  });

  it('INSERT 自动注入 tenant_id', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');

    tenantDb.prepare<void>(
      'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
    ).run('val_1', '诚信', 0.8, 1000);

    /* 通过底层数据库验证 tenant_id 已注入 */
    const row = baseDb.prepare<{ id: string; tenant_id: string; label: string }>(
      'SELECT id, tenant_id, label FROM core_values WHERE id = ?',
    ).get('val_1');
    assert.equal(row?.tenant_id, 'tenant-a');
    assert.equal(row?.label, '诚信');
  });

  it('SELECT 自动过滤 tenant_id', () => {
    /* 手动插入两个租户的数据 */
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_a', 'tenant-a', '诚信', 0.8, 1000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_b', 'tenant-b', '勇气', 0.6, 1000);

    const tenantA = new TenantDatabase(baseDb, 'tenant-a');
    const rows = tenantA.prepare<{ id: string; label: string }>(
      'SELECT id, label FROM core_values',
    ).all();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'val_a');
  });

  it('UPDATE 仅影响本租户数据', () => {
    /* 不同租户不同 ID（core_values.id 是 PK） */
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_a1', 'tenant-a', '诚信', 0.8, 1000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_b1', 'tenant-b', '诚信', 0.5, 1000);

    const tenantA = new TenantDatabase(baseDb, 'tenant-a');
    tenantA.prepare<void>(
      'UPDATE core_values SET weight = ? WHERE id = ?',
    ).run(0.9, 'val_a1');

    /* tenant-a 的已更新 */
    const rowA = baseDb.prepare<{ weight: number }>(
      'SELECT weight FROM core_values WHERE id = ? AND tenant_id = ?',
    ).get('val_a1', 'tenant-a');
    assert.equal(rowA?.weight, 0.9);

    /* tenant-b 不受影响 */
    const rowB = baseDb.prepare<{ weight: number }>(
      'SELECT weight FROM core_values WHERE id = ? AND tenant_id = ?',
    ).get('val_b1', 'tenant-b');
    assert.equal(rowB?.weight, 0.5);
  });

  it('DELETE 仅删除本租户数据', () => {
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_1', 'tenant-a', '诚信', 0.8, 1000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_2', 'tenant-b', '勇气', 0.6, 1000);

    const tenantA = new TenantDatabase(baseDb, 'tenant-a');
    tenantA.prepare<void>('DELETE FROM core_values WHERE id = ?').run('val_1');

    const all = baseDb.prepare<{ id: string }>('SELECT id FROM core_values').all();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'val_2');
  });

  it('DELETE WHERE 1=1 仅删除本租户数据', () => {
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_a', 'tenant-a', '诚信', 0.8, 1000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_b', 'tenant-b', '勇气', 0.6, 1000);

    const tenantA = new TenantDatabase(baseDb, 'tenant-a');
    tenantA.prepare<void>('DELETE FROM core_values WHERE 1=1').run();

    /* tenant-a 数据已删除 */
    const rowsA = baseDb.prepare<{ id: string }>(
      'SELECT id FROM core_values WHERE tenant_id = ?',
    ).all('tenant-a');
    assert.equal(rowsA.length, 0);

    /* tenant-b 数据未受影响 */
    const rowsB = baseDb.prepare<{ id: string }>(
      'SELECT id FROM core_values WHERE tenant_id = ?',
    ).all('tenant-b');
    assert.equal(rowsB.length, 1);
  });

  it('非租户表不改写 SQL', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    /* schema_migrations 不是租户表 */
    const rows = tenantDb.prepare<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all();
    assert.ok(rows.length > 0);
  });

  it('exec() 拒绝对租户表执行 DML', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    assert.throws(
      () => tenantDb.exec('DELETE FROM core_values'),
      /禁止通过 exec\(\) 对租户表.*执行 DELETE/,
    );
  });

  it('exec() 允许 DDL 语句', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    /* DDL 不被拦截 */
    assert.doesNotThrow(() => {
      tenantDb.exec('CREATE TABLE IF NOT EXISTS test_temp (id TEXT PRIMARY KEY)');
    });
    /* 清理 */
    baseDb.exec('DROP TABLE IF EXISTS test_temp');
  });

  it('prepare() 拒绝 CTE 语法', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    assert.throws(
      () => tenantDb.prepare('WITH cte AS (SELECT * FROM core_values) SELECT * FROM cte'),
      /不支持 CTE 语法/,
    );
  });

  it('transaction 透传到底层', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    tenantDb.transaction(() => {
      tenantDb.prepare<void>(
        'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
      ).run('val_tx', '测试', 0.5, 1000);
    });
    const row = baseDb.prepare<{ tenant_id: string }>(
      'SELECT tenant_id FROM core_values WHERE id = ?',
    ).get('val_tx');
    assert.equal(row?.tenant_id, 'tenant-a');
  });

  it('close 不关闭底层数据库', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    tenantDb.close();
    /* 底层仍可用 */
    const rows = baseDb.prepare<{ version: string }>('SELECT version FROM schema_migrations').all();
    assert.ok(rows.length > 0);
  });

  it('SELECT 带 ORDER BY 和 LIMIT 正确注入 WHERE', () => {
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('v1', 'tenant-a', 'A', 0.8, 1000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('v2', 'tenant-a', 'B', 0.6, 2000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('v3', 'tenant-b', 'C', 0.5, 3000);

    const tenantA = new TenantDatabase(baseDb, 'tenant-a');
    const rows = tenantA.prepare<{ id: string }>(
      'SELECT id FROM core_values ORDER BY updated_at DESC LIMIT 1',
    ).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'v2');
  });

  it('已含 tenant_id 的 INSERT 跳过重写', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    /* 手动包含 tenant_id 的 INSERT 不应二次注入 */
    tenantDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_manual', 'tenant-a', '手动', 0.7, 1000);

    const row = baseDb.prepare<{ tenant_id: string }>(
      'SELECT tenant_id FROM core_values WHERE id = ?',
    ).get('val_manual');
    assert.equal(row?.tenant_id, 'tenant-a');
  });

  it('SELECT 带 LIMIT/OFFSET 参数时 tenant_id 参数应排在最前', () => {
    let capturedSql = '';
    let capturedParams: SqlValue[] = [];

    const spyDb: IDatabase = {
      dialect: 'sqlite',
      exec() {},
      close() {},
      transaction<T>(fn: () => T): T {
        return fn();
      },
      queryOne: () => null,
      queryMany: () => [],
      execute: () => ({ rowsAffected: 0 }),
      prepare<T = unknown>(sql: string): IPreparedStatement<T> {
        capturedSql = sql;
        return {
          run(...params: SqlValue[]) {
            capturedParams = params;
            return { changes: 0, lastInsertRowid: 0 };
          },
          get(...params: SqlValue[]) {
            capturedParams = params;
            return undefined;
          },
          all(...params: SqlValue[]) {
            capturedParams = params;
            return [];
          },
        };
      },
    };

    const tenantDb = new TenantDatabase(spyDb, 'tenant-a');
    tenantDb.prepare(
      'SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(20, 40);

    assert.match(
      capturedSql,
      /SELECT \* FROM memory_nodes\s+WHERE tenant_id = \?\s+ORDER BY created_at DESC LIMIT \? OFFSET \?/i,
    );
    assert.deepEqual(capturedParams, ['tenant-a', 20, 40]);
  });

  it('已有 WHERE 时应保持 tenant_id 在首位并包裹原谓词', () => {
    let capturedSql = '';
    let capturedParams: SqlValue[] = [];

    const spyDb: IDatabase = {
      dialect: 'sqlite',
      exec() {},
      close() {},
      transaction<T>(fn: () => T): T {
        return fn();
      },
      queryOne: () => null,
      queryMany: () => [],
      execute: () => ({ rowsAffected: 0 }),
      prepare<T = unknown>(sql: string): IPreparedStatement<T> {
        capturedSql = sql;
        return {
          run(...params: SqlValue[]) {
            capturedParams = params;
            return { changes: 0, lastInsertRowid: 0 };
          },
          get(...params: SqlValue[]) {
            capturedParams = params;
            return undefined;
          },
          all(...params: SqlValue[]) {
            capturedParams = params;
            return [];
          },
        };
      },
    };

    const tenantDb = new TenantDatabase(spyDb, 'tenant-a');
    tenantDb.prepare(
      'SELECT * FROM memory_nodes WHERE id = ? OR consolidated_from = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all('mem_1', 'mem_2', 10, 0);

    assert.match(
      capturedSql,
      /WHERE tenant_id = \? AND \(id = \? OR consolidated_from = \?\)\s+ORDER BY created_at DESC LIMIT \? OFFSET \?/i,
    );
    assert.deepEqual(capturedParams, ['tenant-a', 'mem_1', 'mem_2', 10, 0]);
  });
});
