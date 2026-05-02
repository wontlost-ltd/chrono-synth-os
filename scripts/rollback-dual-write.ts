#!/usr/bin/env node
// Rollback drill: switches AuthorityMode from dual_write -> tables_primary
// Usage: node dist/scripts/rollback-dual-write.js <db-path>
import { SqliteDatabase } from '../src/storage/database.js';
import { runMigrations } from '../src/storage/migrations.js';
import { SqliteAuthoritySwitch } from '../src/data-plane/sqlite-event-ledger.js';

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? ':memory:';
  const db = new SqliteDatabase(dbPath);
  runMigrations(db);
  const sw = new SqliteAuthoritySwitch(db);
  const before = await sw.currentMode();
  await sw.switchTo('tables_primary', 'rollback-drill: manual rollback');
  const after = await sw.currentMode();
  console.log(JSON.stringify({ before, after, success: after === 'tables_primary' }));
  db.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
