#!/usr/bin/env node
/**
 * Migration dry-run + impact report — P1-U-migration-safety.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.8 P1-U-migration-safety
 *
 * Compares the migrations recorded in `schema_migrations` against the
 * SQL renderer's output for the configured target. Prints:
 *   - PENDING: migrations that will be applied on next start
 *   - APPLIED: already done
 *   - SQL preview of every PENDING migration so the operator can eyeball
 *     destructive ops (DROP COLUMN / TYPE CHANGE / etc.) before rollout
 *
 * Reads from a live DB; does NOT mutate. Safe to point at prod
 * read-replica.
 *
 * Usage:
 *   PG_URL=postgres://... TARGET=postgres node dist/scripts/migration-dry-run.js
 *   SQLITE_PATH=./var/chrono.db TARGET=sqlite-sql node dist/scripts/migration-dry-run.js
 *
 * Exit codes:
 *   0  no pending migrations
 *   1  pending migrations exist (CI gate friendly — fails if your branch
 *      adds migrations that haven't been reviewed)
 *   2  invalid invocation / DB error
 */

import { renderAllForTarget } from '../src/storage/dsl-migrations-runner.js';
import type { IDatabase } from '../src/storage/database.js';

async function openDb(): Promise<IDatabase> {
  const pgUrl = process.env.PG_URL;
  if (pgUrl) {
    const { PostgresDatabase } = await import('../src/storage/postgres-database.js');
    return new PostgresDatabase(pgUrl, { max: 2, idleTimeoutMs: 10_000 });
  }
  const sqlitePath = process.env.SQLITE_PATH;
  if (!sqlitePath) {
    console.error('Either PG_URL or SQLITE_PATH must be set');
    process.exit(2);
  }
  const { SqliteDatabase } = await import('../src/storage/database.js');
  return new SqliteDatabase(sqlitePath);
}

interface MigrationRow {
  version: string;
}

async function main(): Promise<void> {
  const target = (process.env.TARGET ?? 'sqlite-sql') as 'postgres' | 'sqlite-sql';
  if (target !== 'postgres' && target !== 'sqlite-sql') {
    console.error('TARGET env var must be "postgres" or "sqlite-sql"');
    process.exit(2);
  }
  const db = await openDb();
  try {
    const allRendered = renderAllForTarget(target);
    /* schema_migrations may not exist yet on a fresh DB. Try and degrade. */
    let appliedVersions: Set<string>;
    try {
      const rows = db.prepare<MigrationRow>(
        'SELECT version FROM schema_migrations',
      ).all();
      appliedVersions = new Set(rows.map(r => r.version));
    } catch {
      appliedVersions = new Set<string>();
    }
    const pending = allRendered.filter(m => !appliedVersions.has(m.version));
    const applied = allRendered.filter(m => appliedVersions.has(m.version));

    console.log(`Target:              ${target}`);
    console.log(`Total migrations:    ${allRendered.length}`);
    console.log(`Applied:             ${applied.length}`);
    console.log(`Pending:             ${pending.length}`);
    console.log('');
    if (pending.length === 0) {
      console.log('No pending migrations.');
      process.exit(0);
    }

    console.log('=== PENDING MIGRATIONS (SQL preview) ===');
    for (const m of pending) {
      console.log('');
      console.log(`-- ${m.version}: ${m.description}`);
      for (const stmt of m.sql) {
        const oneLine = stmt.split('\n').map(s => s.trim()).filter(Boolean).join(' ');
        /* Highlight destructive ops at the top so an operator scanning
         * the preview sees them immediately. */
        const tag = /DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE|ALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN/i.test(oneLine)
          ? '!! DESTRUCTIVE: '
          : '';
        console.log(`  ${tag}${oneLine}`);
      }
    }
    console.log('');
    console.log(`${pending.length} migration(s) pending — review before deployment.`);
    /* Exit non-zero so CI's "no surprise migrations" check can be wired
     * to this command (set TARGET=postgres against a prod snapshot). */
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('migration-dry-run failed:', err);
  process.exit(2);
});
