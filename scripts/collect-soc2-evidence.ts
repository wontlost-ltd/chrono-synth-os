#!/usr/bin/env node
/**
 * Run the built-in SOC2 evidence collectors against every active tenant.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-L-basic
 *
 * Intended deployment: Kubernetes CronJob (daily or hourly per tenant
 * count). Exits non-zero if any collector reports an error so the CronJob
 * surfaces failure to the alerting pipeline.
 *
 * Usage:
 *   # PostgreSQL (production)
 *   PG_URL=postgres://chrono:chrono@db:5432/chrono \
 *     node dist/scripts/collect-soc2-evidence.js
 *
 *   # SQLite (dev / single-tenant)
 *   SQLITE_PATH=./var/chrono.db \
 *     node dist/scripts/collect-soc2-evidence.js
 *
 *   # Restrict to specific tenants (comma-separated)
 *   PG_URL=... TENANT_IDS=tenant-a,tenant-b \
 *     node dist/scripts/collect-soc2-evidence.js
 */

import { runAllBuiltInCollectors } from '../src/compliance/evidence-collectors.js';
import type { IDatabase } from '../src/storage/database.js';

async function openDb(): Promise<IDatabase> {
  const pgUrl = process.env.PG_URL;
  if (pgUrl) {
    const { PostgresDatabase } = await import('../src/storage/postgres-database.js');
    return new PostgresDatabase(pgUrl, { max: 5, idleTimeoutMs: 10_000 });
  }
  const sqlitePath = process.env.SQLITE_PATH;
  if (!sqlitePath) {
    console.error('Either PG_URL or SQLITE_PATH must be set');
    process.exit(2);
  }
  const { SqliteDatabase } = await import('../src/storage/database.js');
  return new SqliteDatabase(sqlitePath);
}

function tenantIdsFromEnv(db: IDatabase): string[] {
  const override = process.env.TENANT_IDS?.trim();
  if (override) return override.split(',').map(s => s.trim()).filter(Boolean);
  /* Default: every distinct tenant_id observed in `users`. Adapted for both
   * dialects via prepared statement. */
  const rows = db.prepare<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM users WHERE tenant_id IS NOT NULL',
  ).all();
  return rows.map(r => r.tenant_id);
}

async function main(): Promise<void> {
  const db = await openDb();
  try {
    const tenantIds = tenantIdsFromEnv(db);
    if (tenantIds.length === 0) {
      console.error('No tenants found; nothing to collect.');
      process.exit(0);
    }
    console.error(`Collecting SOC2 evidence for ${tenantIds.length} tenants…`);
    const reports = runAllBuiltInCollectors(db, tenantIds);
    let totalCollected = 0;
    let totalErrors = 0;
    for (const r of reports) {
      totalCollected += r.collectedCount;
      totalErrors += r.errors.length;
      console.log(JSON.stringify(r));
    }
    console.error(`done: collected=${totalCollected} errors=${totalErrors}`);
    process.exit(totalErrors > 0 ? 1 : 0);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('collector run failed:', err);
  process.exit(2);
});
