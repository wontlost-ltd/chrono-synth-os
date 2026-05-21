/**
 * P0-C 否定测试 — RLS 10000-iter property-based fuzz
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C #1
 *
 * 对 TenantDatabase 进行 10000 次随机生成的 SQL（SELECT/UPDATE/DELETE/INSERT）
 * 各种 shape 的不变式断言：
 *   - SELECT: 任何返回行的 tenant_id 必须 == context tenant
 *   - UPDATE: 不影响他租户行的 updated_at（多种 WHERE 形状）
 *   - DELETE: 真删 candidate（自租户或他租户 id），断言只有自租户被删
 *   - INSERT: 后插入行的 tenant_id == context tenant
 *
 * SQL shape 覆盖：no-WHERE / WHERE / WHERE IN / ORDER BY / LIMIT / OFFSET /
 *               GROUP BY / HAVING / 多列 SELECT。
 *
 * 错误观测：每个 iter 记录 success/throw（按 op + shape），断言成功率 ≥ 70%
 * 防止 try/catch 静默吞掉绝大多数测试。
 *
 * Seedable PRNG (mulberry32) 让失败可复现：
 *   FUZZ_SEED=12345 npm run test:integration -- src/test/integration/negative-rls-fuzz.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantDatabase } from '../../multi-tenant/tenant-database.js';
import type { IDatabase } from '../../storage/database.js';

/* mulberry32 — seedable, deterministic uint32 PRNG */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

const TENANTS = ['t-a', 't-b', 't-c', 't-d', 't-e'];
const ROWS_PER_TENANT_INITIAL = 50;  /* enough to allow DELETE/UPDATE wear */
const SUCCESS_FLOOR_PCT = 70;        /* < 70% successful ops → suspicious */

/* Seed corpus: each tenant gets N rows. We rebuild between iterations as needed
 * by INSERT/DELETE balancing. IDs are tenant-prefixed so cross-leakage is
 * trivially detected by reading id back through baseDb. */
function seedCorpus(base: IDatabase): void {
  const ins = base.prepare<void>(
    'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const t of TENANTS) {
    for (let i = 0; i < ROWS_PER_TENANT_INITIAL; i++) {
      const id = `${t}-seed-${i}`;
      ins.run(id, t, `${t}-label-${i}`, (i % 10) / 10, 1000 + i);
    }
  }
}

interface FuzzReport {
  iterations: number;
  ops: Record<string, number>;          /* attempts per op */
  successes: Record<string, number>;    /* successful (non-throw) per op */
  shapeSuccesses: Record<string, number>; /* per shape label */
  shapeAttempts: Record<string, number>;
  crossLeaks: Array<{ iter: number; op: string; shape: string; seedTenant: string; detail: string }>;
}

describe('P0-C negative — RLS 10000-iter property-based fuzz', () => {
  let base: IDatabase;
  const seed = Number(process.env.FUZZ_SEED) || 0xCA7C0FFEE;
  const rng = makeRng(seed);
  const iterations = Number(process.env.FUZZ_ITERATIONS) || 10000;

  before(() => {
    base = createMemoryDatabase();
    runDslSqliteMigrations(base);
    seedCorpus(base);
    console.log(`[P0-C fuzz] seed=${seed} iterations=${iterations}`);
  });

  it(`0 跨租户泄漏 + ≥${SUCCESS_FLOOR_PCT}% 成功率 (10000 iter)`, () => {
    const report: FuzzReport = {
      iterations: 0,
      ops: { SELECT: 0, UPDATE: 0, DELETE: 0, INSERT: 0 },
      successes: { SELECT: 0, UPDATE: 0, DELETE: 0, INSERT: 0 },
      shapeSuccesses: {},
      shapeAttempts: {},
      crossLeaks: [],
    };

    const pickTenant = (): string => TENANTS[Math.floor(rng() * TENANTS.length)] ?? TENANTS[0]!;
    const tenantDb = (t: string) => new TenantDatabase(base, t);

    const bumpShape = (shape: string, succeeded: boolean): void => {
      report.shapeAttempts[shape] = (report.shapeAttempts[shape] ?? 0) + 1;
      if (succeeded) {
        report.shapeSuccesses[shape] = (report.shapeSuccesses[shape] ?? 0) + 1;
      }
    };

    for (let iter = 0; iter < iterations; iter++) {
      const op = ['SELECT', 'UPDATE', 'DELETE', 'INSERT'][Math.floor(rng() * 4)]!;
      const tenant = pickTenant();
      const db = tenantDb(tenant);
      report.ops[op]! += 1;
      /* Pre-select shape for SELECT/UPDATE so the catch path can attribute it.
       * DELETE/INSERT have single shape today. */
      let shapeLabel = '';

      try {
        if (op === 'SELECT') {
          const shapes: Array<{ label: string; sql: string; param?: unknown }> = [
            { label: 'no-where', sql: 'SELECT id FROM core_values' },
            { label: 'where-weight', sql: 'SELECT id, label FROM core_values WHERE weight > ?', param: rng() * 0.5 },
            { label: 'where-like', sql: 'SELECT id FROM core_values WHERE label LIKE ?', param: '%label%' },
            { label: 'order-updated', sql: 'SELECT id FROM core_values ORDER BY updated_at' },
            { label: 'limit', sql: 'SELECT id FROM core_values LIMIT 3' },
            { label: 'order-limit', sql: 'SELECT id FROM core_values ORDER BY weight DESC LIMIT 2' },
            { label: 'limit-offset', sql: 'SELECT id FROM core_values ORDER BY id LIMIT 5 OFFSET 1' },
            { label: 'group-having', sql: 'SELECT label, COUNT(*) AS n FROM core_values GROUP BY label HAVING n >= 1' },
            { label: 'count-only', sql: 'SELECT COUNT(*) AS n FROM core_values' },
          ];
          const pick = shapes[Math.floor(rng() * shapes.length)]!;
          shapeLabel = `SELECT:${pick.label}`;
          bumpShape(shapeLabel, false);  /* attempt counted up front */

          const rows = pick.param !== undefined
            ? db.prepare<Record<string, unknown>>(pick.sql).all(pick.param as never)
            : db.prepare<Record<string, unknown>>(pick.sql).all();
          report.successes.SELECT! += 1;
          report.shapeSuccesses[shapeLabel] = (report.shapeSuccesses[shapeLabel] ?? 0) + 1;

          /* For id-bearing rows: verify real tenant_id matches context. */
          for (const r of rows) {
            const id = (r as { id?: unknown }).id;
            if (typeof id !== 'string') continue;
            const real = base.prepare<{ tenant_id: string }>(
              'SELECT tenant_id FROM core_values WHERE id = ?',
            ).get(id);
            if (real?.tenant_id !== tenant) {
              report.crossLeaks.push({
                iter, op, shape: pick.label, seedTenant: tenant,
                detail: `row id=${id} real_tenant=${real?.tenant_id ?? '<missing>'}`,
              });
            }
          }

          /* Aggregate-only shapes: assert isolation directly. */
          if (pick.label === 'count-only') {
            /* COUNT(*) from tenant view must equal direct-count of own rows.
             * If the rewriter dropped the WHERE tenant_id filter, count would
             * equal total rows, leaking foreign-tenant row count. */
            const tenantCount = (rows[0] as { n?: number } | undefined)?.n ?? -1;
            const expected = base.prepare<{ n: number }>(
              'SELECT COUNT(*) AS n FROM core_values WHERE tenant_id = ?',
            ).get(tenant)?.n ?? 0;
            if (tenantCount !== expected) {
              report.crossLeaks.push({
                iter, op, shape: pick.label, seedTenant: tenant,
                detail: `COUNT(*) returned ${tenantCount}, expected own-tenant count ${expected}`,
              });
            }
          } else if (pick.label === 'group-having') {
            /* GROUP BY label must only return labels belonging to context tenant.
             * Each label in our seed corpus is prefixed by its tenant id,
             * so any returned label starting with a different `${other}-` leaks. */
            for (const r of rows) {
              const lbl = (r as { label?: unknown }).label;
              if (typeof lbl !== 'string') continue;
              /* Labels we plant: `${tenant}-label-N`, `${tenant}-%` patterns
               * created in INSERT below, or `restore-${iter}` / `fuzz-${iter}`
               * (tenant-context-agnostic ids but those land via TenantDatabase
               * so they are still own-tenant). The cross-leak signal is a label
               * that starts with another known tenant's prefix. */
              for (const other of TENANTS) {
                if (other !== tenant && lbl.startsWith(`${other}-`)) {
                  report.crossLeaks.push({
                    iter, op, shape: pick.label, seedTenant: tenant,
                    detail: `GROUP BY returned label "${lbl}" belonging to ${other}`,
                  });
                  break;
                }
              }
            }
          }
        } else if (op === 'UPDATE') {
          /* Snapshot other-tenant rows before */
          const otherBefore = base.prepare<{ id: string; updated_at: number }>(
            'SELECT id, updated_at FROM core_values WHERE tenant_id != ?',
          ).all(tenant);

          const newTs = 9_000_000 + iter;
          const shapes: Array<{ label: string; sql: string; params: unknown[] }> = [
            { label: 'no-where', sql: 'UPDATE core_values SET updated_at = ?', params: [newTs] },
            { label: 'where-id', sql: 'UPDATE core_values SET updated_at = ? WHERE id = ?',
              params: [newTs, `${tenant}-seed-${Math.floor(rng() * 5)}`] },
            { label: 'where-weight', sql: 'UPDATE core_values SET updated_at = ? WHERE weight > ?',
              params: [newTs, rng() * 0.5] },
            { label: 'where-like', sql: 'UPDATE core_values SET updated_at = ? WHERE label LIKE ?',
              params: [newTs, `${tenant}-%`] },
          ];
          const pick = shapes[Math.floor(rng() * shapes.length)]!;
          shapeLabel = `UPDATE:${pick.label}`;
          bumpShape(shapeLabel, false);

          db.prepare<void>(pick.sql).run(...pick.params as never[]);
          report.successes.UPDATE! += 1;
          report.shapeSuccesses[shapeLabel] = (report.shapeSuccesses[shapeLabel] ?? 0) + 1;

          for (const beforeRow of otherBefore) {
            const after = base.prepare<{ updated_at: number; tenant_id: string }>(
              'SELECT updated_at, tenant_id FROM core_values WHERE id = ?',
            ).get(beforeRow.id);
            if (after && after.updated_at !== beforeRow.updated_at) {
              report.crossLeaks.push({
                iter, op, shape: pick.label, seedTenant: tenant,
                detail: `other-tenant row id=${beforeRow.id} (real_tenant=${after.tenant_id}) updated_at changed ${beforeRow.updated_at}→${after.updated_at}`,
              });
            }
          }
        } else if (op === 'DELETE') {
          /* Real DELETE: target tenant's own row OR other tenant's row.
           * If TenantDatabase fails to inject tenant_id and we target other-tenant id,
           * the DELETE would succeed and the other-tenant count drops → leak.
           *
           * To avoid corpus depletion, we re-insert one row after each DELETE.
           * Test invariant: only own-tenant rows can decrease. */
          const otherCountBefore = base.prepare<{ n: number }>(
            'SELECT COUNT(*) AS n FROM core_values WHERE tenant_id != ?',
          ).get(tenant)?.n ?? 0;
          const ownCountBefore = base.prepare<{ n: number }>(
            'SELECT COUNT(*) AS n FROM core_values WHERE tenant_id = ?',
          ).get(tenant)?.n ?? 0;

          /* Pick target id from a random tenant (could be self or other).
           * Important: this is the leak-detection part — if rewriter drops
           * the tenant_id filter, a foreign id will actually delete. */
          const targetTenant = pickTenant();
          const targetIdNum = Math.floor(rng() * Math.max(1, ROWS_PER_TENANT_INITIAL));
          const targetId = `${targetTenant}-seed-${targetIdNum}`;

          shapeLabel = 'DELETE:where-id';
          bumpShape(shapeLabel, false);

          db.prepare<void>('DELETE FROM core_values WHERE id = ?').run(targetId);
          report.successes.DELETE! += 1;
          report.shapeSuccesses[shapeLabel] = (report.shapeSuccesses[shapeLabel] ?? 0) + 1;

          const otherCountAfter = base.prepare<{ n: number }>(
            'SELECT COUNT(*) AS n FROM core_values WHERE tenant_id != ?',
          ).get(tenant)?.n ?? 0;
          const ownCountAfter = base.prepare<{ n: number }>(
            'SELECT COUNT(*) AS n FROM core_values WHERE tenant_id = ?',
          ).get(tenant)?.n ?? 0;

          /* Invariant: other-tenant count must never decrease.
           * Own-tenant count may decrease (if targetTenant==tenant && row existed). */
          if (otherCountAfter < otherCountBefore) {
            report.crossLeaks.push({
              iter, op, shape: 'where-id', seedTenant: tenant,
              detail: `other-tenant count ${otherCountBefore}→${otherCountAfter} (targeted id=${targetId} in ${targetTenant})`,
            });
          }

          /* Re-insert if we actually deleted an own row, to keep corpus alive */
          if (ownCountAfter < ownCountBefore) {
            base.prepare<void>(
              'INSERT INTO core_values (id, tenant_id, label, weight, updated_at) VALUES (?, ?, ?, ?, ?)',
            ).run(targetId, tenant, `restore-${iter}`, 0.5, 2000 + iter);
          }
        } else if (op === 'INSERT') {
          shapeLabel = 'INSERT:values';
          bumpShape(shapeLabel, false);

          const id = `${tenant}-fuzz-${iter}`;
          db.prepare<void>(
            'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
          ).run(id, `fuzz-${iter}`, (iter % 10) / 10, 5_000_000 + iter);
          report.successes.INSERT! += 1;
          report.shapeSuccesses[shapeLabel] = (report.shapeSuccesses[shapeLabel] ?? 0) + 1;

          const row = base.prepare<{ tenant_id: string }>(
            'SELECT tenant_id FROM core_values WHERE id = ?',
          ).get(id);
          if (row?.tenant_id !== tenant) {
            report.crossLeaks.push({
              iter, op, shape: 'values', seedTenant: tenant,
              detail: `inserted id=${id} real_tenant=${row?.tenant_id ?? '<missing>'}`,
            });
          }
        }
      } catch {
        /* Failed op. We still track to enforce success floor. */
      }

      report.iterations += 1;
    }

    /* Per-op success floor: must be ≥ SUCCESS_FLOOR_PCT */
    const failures: string[] = [];
    for (const op of Object.keys(report.ops)) {
      const total = report.ops[op]!;
      const ok = report.successes[op]!;
      if (total > 0) {
        const pct = (ok / total) * 100;
        if (pct < SUCCESS_FLOOR_PCT) {
          failures.push(`${op} success=${ok}/${total} (${pct.toFixed(1)}% < ${SUCCESS_FLOOR_PCT}%)`);
        }
      }
    }

    if (report.crossLeaks.length > 0) {
      console.error(`[P0-C fuzz] ${report.crossLeaks.length} cross-tenant leaks (first 5):`);
      for (const leak of report.crossLeaks.slice(0, 5)) {
        console.error(JSON.stringify(leak));
      }
    }

    if (failures.length > 0) {
      console.error(`[P0-C fuzz] success floor breached:\n${failures.join('\n')}`);
      console.error('[P0-C fuzz] shape breakdown:');
      for (const shape of Object.keys(report.shapeAttempts).sort()) {
        console.error(`  ${shape}: ${report.shapeSuccesses[shape] ?? 0}/${report.shapeAttempts[shape]}`);
      }
    }

    assert.equal(report.crossLeaks.length, 0,
      `seed=${seed}: ${report.crossLeaks.length} cross-tenant leaks. ` +
      `Set FUZZ_SEED=${seed} to reproduce.`,
    );
    assert.equal(failures.length, 0,
      `seed=${seed}: success floor breached (${failures.join('; ')}). Likely test smell.`,
    );
    assert.equal(report.iterations, iterations);
  });
});
