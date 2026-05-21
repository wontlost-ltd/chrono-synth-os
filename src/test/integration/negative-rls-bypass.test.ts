/**
 * P0-C 否定测试 — RLS 绕过尝试
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §8 #3
 *
 * 验证 TenantDatabase 应用层 RLS 在面对各种已知 SQL 注入 / 跨租户访问尝试时
 * 全部抛错或返回 0 行；任何绕过都是 GA Blocker 级别的故障。
 *
 * 这是 negative-only 测试：每个 case 应抛错或返回空。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantDatabase } from '../../multi-tenant/tenant-database.js';
import type { IDatabase } from '../../storage/database.js';

describe('P0-C negative — RLS 绕过尝试全部拒绝', () => {
  let baseDb: IDatabase;
  let tenantA: TenantDatabase;

  beforeEach(() => {
    baseDb = createMemoryDatabase();
    runDslSqliteMigrations(baseDb);
    tenantA = new TenantDatabase(baseDb, 'tenant-a');

    /* 种子数据：每租户一行 */
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_a', 'tenant-a', '诚信-A', 0.8, 1000);
    baseDb.prepare<void>(
      'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('val_b', 'tenant-b', '勇气-B', 0.6, 1000);
  });

  describe('exec() 路径拦截（无参数化 DML 必须抛错）', () => {
    it('exec INSERT 到租户表抛错', () => {
      assert.throws(
        () => tenantA.exec(`INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES ('hack', 'tenant-b', 'hack', 1.0, 9999)`),
        /禁止通过 exec\(\) 对租户表/,
      );
    });

    it('exec UPDATE 到租户表抛错', () => {
      assert.throws(
        () => tenantA.exec(`UPDATE core_values SET weight = 1.0`),
        /禁止通过 exec\(\) 对租户表/,
      );
    });

    it('exec DELETE 到租户表抛错', () => {
      assert.throws(
        () => tenantA.exec(`DELETE FROM core_values`),
        /禁止通过 exec\(\) 对租户表/,
      );
    });

    it('exec DDL（非 DML）放行（CREATE TABLE 不涉及租户语义）', () => {
      assert.doesNotThrow(() =>
        tenantA.exec('CREATE TABLE IF NOT EXISTS _scratch (k TEXT)'),
      );
    });
  });

  describe('prepare() 路径无法绕过 — 自动注入 tenant_id', () => {
    it('SELECT 不会返回他租户行（即使 SQL 没显式 WHERE）', () => {
      const rows = tenantA.prepare<{ id: string }>('SELECT id FROM core_values').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, 'val_a');
    });

    it('UPDATE 不会修改他租户行（即使没 WHERE）', () => {
      tenantA.prepare<void>('UPDATE core_values SET weight = 0.99').run();

      const otherRow = baseDb.prepare<{ weight: number }>(
        "SELECT weight FROM core_values WHERE tenant_id = 'tenant-b'",
      ).get();
      assert.equal(otherRow?.weight, 0.6, 'tenant-b 的 weight 不应被改');
    });

    it('DELETE 不会清空他租户行（即使没 WHERE）', () => {
      tenantA.prepare<void>('DELETE FROM core_values').run();

      const otherRow = baseDb.prepare<{ id: string }>(
        "SELECT id FROM core_values WHERE tenant_id = 'tenant-b'",
      ).get();
      assert.equal(otherRow?.id, 'val_b', 'tenant-b 的行应仍存在');
    });
  });

  describe('已知 SQL 重写盲区被显式拒绝（不静默放行）', () => {
    it('CTE (WITH) 抛错', () => {
      assert.throws(
        () => tenantA.prepare(
          'WITH x AS (SELECT * FROM core_values) SELECT * FROM x',
        ),
        /不支持 CTE/,
      );
    });

    it('UNION 抛错', () => {
      assert.throws(
        () => tenantA.prepare(
          'SELECT id FROM core_values UNION SELECT id FROM core_values',
        ),
        /不支持 UNION/,
      );
    });

    it('INSERT...SELECT 抛错（重写器拒绝非 VALUES 形式）', () => {
      /* 实现细节：tenant-database 在 INSERT 列检测后进入重写路径，
       * 非 VALUES 形式（如 INSERT...SELECT）会因列模式不匹配抛
       * "INSERT 重写失败"，也是有效的拒绝路径。 */
      assert.throws(
        () => tenantA.prepare(
          'INSERT INTO core_values (id, label, weight, updated_at) SELECT id, label, weight, updated_at FROM core_values',
        ),
        /TenantDatabase: (不支持 INSERT\.\.\.SELECT|INSERT 重写失败)/,
      );
    });
  });

  describe('Property-based smoke: 100 次随机 tenant 对调，0 次跨租户泄漏', () => {
    /* v7.3 §2.2 acceptance: full 10000-case fuzz is P0-C #1 (separate 2d task,
     * tracked in `.claude/runbooks/p0-c-acceptance.md`). This 100-iter smoke
     * variant covers the simple SELECT path only. The full fuzz will add
     * random WHERE clauses, JOINs, ORDER BY, LIMIT and subquery shapes
     * that actually exercise the SQL rewriter. */
    it('随机 SELECT 永远不返回 cross-tenant 行', () => {
      const tenants = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-x', 'tenant-y'];
      let crossLeaks = 0;
      for (let i = 0; i < 100; i++) {
        const t = tenants[i % tenants.length];
        const db = new TenantDatabase(baseDb, t);
        const rows = db.prepare<{ id: string; tenant_id?: string }>(
          'SELECT id FROM core_values',
        ).all();
        /* 任何返回行的 tenant_id 必须与当前 context 相同 */
        for (const r of rows) {
          /* 用 baseDb 查回 tenant_id 确认 */
          const real = baseDb.prepare<{ tenant_id: string }>(
            'SELECT tenant_id FROM core_values WHERE id = ?',
          ).get(r.id);
          if (real?.tenant_id !== t) {
            crossLeaks += 1;
          }
        }
      }
      assert.equal(crossLeaks, 0, `fuzz 100 次出现 ${crossLeaks} 次跨租户泄漏`);
    });
  });
});
