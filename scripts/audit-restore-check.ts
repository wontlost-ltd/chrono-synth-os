#!/usr/bin/env node
/**
 * Audit log restore integrity check — P1-I-5.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.4 P1-I-5
 *
 * Purpose: validate the audit_log hash chain end-to-end for one or all
 * tenants. Operationalises P0-E's verifyAuditChain() as the restore-
 * time gate: after PITR + WAL replay, this script tells you whether
 * the restored data is intact and where any breaks are.
 *
 * Output for each tenant:
 *   { tenantId, ok, totalChecked, breakCount, firstBreakAtSeq }
 *
 * Exit codes:
 *   0  every tenant chain verifies clean
 *   1  ≥1 tenant chain has breaks
 *   2  invalid invocation / DB error
 *
 * Usage:
 *   # All tenants
 *   PG_URL=... node dist/scripts/audit-restore-check.js
 *   # Specific tenants
 *   PG_URL=... TENANT_IDS=t1,t2 node dist/scripts/audit-restore-check.js
 */

import { verifyAuditChain } from '../src/audit/audit-log-store.js';
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

async function main(): Promise<void> {
  const db = await openDb();
  try {
    let tenantIds: string[];
    const override = process.env.TENANT_IDS?.trim();
    if (override) {
      tenantIds = override.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      const rows = db.prepare<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM audit_log WHERE chain_seq IS NOT NULL',
      ).all();
      tenantIds = rows.map(r => r.tenant_id);
    }

    if (tenantIds.length === 0) {
      console.log('No tenants with chained audit data; nothing to verify.');
      process.exit(0);
    }

    let totalBroken = 0;
    for (const tenantId of tenantIds) {
      const result = verifyAuditChain(db, tenantId);
      const firstBreak = result.breaks[0];
      const summary = {
        tenantId,
        ok: result.ok,
        totalChecked: result.totalChecked,
        breakCount: result.breaks.length,
        firstBreakAtSeq: firstBreak?.chainSeq ?? null,
        firstBreakReason: firstBreak?.reason ?? null,
      };
      console.log(JSON.stringify(summary));
      if (!result.ok) totalBroken += 1;
    }

    if (totalBroken > 0) {
      console.error('');
      console.error(`${totalBroken} of ${tenantIds.length} tenant chain(s) broken.`);
      console.error('Next steps:');
      console.error('  1. Identify the most recent intact chain_seq from PITR backups');
      console.error('  2. Restore only the audit_log rows up to that seq');
      console.error('  3. Replay subsequent rows from append-only backup (if any)');
      console.error('  4. Re-run this script to confirm restore was clean');
      process.exit(1);
    }
    console.error(`All ${tenantIds.length} tenant audit chains verified clean.`);
    process.exit(0);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('audit-restore-check failed:', err);
  process.exit(2);
});
