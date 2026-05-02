import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { SqliteAuthoritySwitch } from '../../data-plane/sqlite-event-ledger.js';
import type { IDatabase } from '../../storage/database.js';

describe('Rollback drill AuthoritySwitch', () => {
  let db: IDatabase;
  let sw: SqliteAuthoritySwitch;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    sw = new SqliteAuthoritySwitch(db);
  });

  it('switches from dual_write back to tables_primary', async () => {
    await sw.switchTo('dual_write', 'enable dual write');
    await sw.switchTo('tables_primary', 'rollback drill');

    assert.equal(await sw.currentMode(), 'tables_primary');
  });

  it('switches from ledger_primary back to tables_primary', async () => {
    await sw.switchTo('ledger_primary', 'promote ledger');
    await sw.switchTo('tables_primary', 'rollback drill');

    assert.equal(await sw.currentMode(), 'tables_primary');
  });

  it('currentMode() returns the new mode after switchTo()', async () => {
    await sw.switchTo('dual_write', 'verify current mode');

    assert.equal(await sw.currentMode(), 'dual_write');
  });

  it('accepts rollback_tables mode', async () => {
    await sw.switchTo('rollback_tables', 'rollback staging mode');

    assert.equal(await sw.currentMode(), 'rollback_tables');
  });
});
