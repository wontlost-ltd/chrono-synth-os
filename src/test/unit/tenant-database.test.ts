import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import { TenantDatabase } from '../../multi-tenant/tenant-database.js';
import type { IDatabase } from '../../storage/database.js';

describe('TenantDatabase', () => {
  let baseDb: IDatabase;

  beforeEach(() => {
    baseDb = createMemoryDatabase();
    runMigrations(baseDb);
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

  it('非租户表不改写 SQL', () => {
    const tenantDb = new TenantDatabase(baseDb, 'tenant-a');
    /* schema_migrations 不是租户表 */
    const rows = tenantDb.prepare<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all();
    assert.ok(rows.length > 0);
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
});
