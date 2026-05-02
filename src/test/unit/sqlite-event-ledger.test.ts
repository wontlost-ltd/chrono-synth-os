import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { SqliteEventLedger, SqliteAuthoritySwitch } from '../../data-plane/sqlite-event-ledger.js';
import { personaCoreDualWrite } from '../../data-plane/persona-core-dual-write.js';
import { VersionConflictError } from '@chrono/data-plane';
import type { IDatabase } from '../../storage/database.js';

function makeDb(): IDatabase {
  const db = createMemoryDatabase();
  runMigrations(db);
  return db;
}

const DRAFT = {
  eventType: 'persona.updated',
  schemaVersion: 1,
  commandId: 'cmd-1',
  payloadJson: '{"x":1}',
};

describe('SqliteEventLedger', () => {
  let db: IDatabase;
  let ledger: SqliteEventLedger;

  beforeEach(() => {
    db = makeDb();
    ledger = new SqliteEventLedger(db);
  });

  it('append() returns correct newVersion', async () => {
    const result = await ledger.append('t1', 'stream-1', [DRAFT]);
    assert.equal(result.newVersion, 0);
    assert.equal(result.eventCount, 1);

    const result2 = await ledger.append('t1', 'stream-1', [DRAFT, DRAFT]);
    assert.equal(result2.newVersion, 2);
    assert.equal(result2.eventCount, 2);
  });

  it('append() throws VersionConflictError on version mismatch', async () => {
    await ledger.append('t1', 'stream-2', [DRAFT]); // now at version 0
    await assert.rejects(
      () => ledger.append('t1', 'stream-2', [DRAFT], 5),
      (err: unknown) => err instanceof VersionConflictError,
    );
  });

  it('loadStream() returns events in version order', async () => {
    await ledger.append('t1', 'stream-3', [
      { ...DRAFT, commandId: 'cmd-a' },
      { ...DRAFT, commandId: 'cmd-b' },
    ]);
    const events = await ledger.loadStream('t1', 'stream-3');
    assert.equal(events.length, 2);
    assert.ok(events[0]!.streamVersion < events[1]!.streamVersion);
  });

  it('loadStream() with sinceVersion filters correctly', async () => {
    await ledger.append('t1', 'stream-4', [DRAFT, DRAFT, DRAFT]);
    const events = await ledger.loadStream('t1', 'stream-4', 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.streamVersion, 2);
  });

  it('nextBatch() + ackBatch() advances consumer checkpoint', async () => {
    await ledger.append('t1', 'stream-5', [DRAFT, DRAFT]);
    const batch1 = await ledger.nextBatch('consumer-1', 1);
    assert.equal(batch1.events.length, 1);

    await ledger.ackBatch('consumer-1', batch1.batchHandle);

    const batch2 = await ledger.nextBatch('consumer-1', 10);
    assert.equal(batch2.events.length, 1);
  });

  it('empty stream returns empty batch', async () => {
    const batch = await ledger.nextBatch('consumer-2', 10);
    assert.equal(batch.events.length, 0);
  });
});

describe('SqliteAuthoritySwitch', () => {
  it('reads and writes authority mode', async () => {
    const db = makeDb();
    const sw = new SqliteAuthoritySwitch(db);

    const initial = await sw.currentMode();
    assert.equal(initial, 'tables_primary');

    await sw.switchTo('dual_write', 'testing dual write');
    const updated = await sw.currentMode();
    assert.equal(updated, 'dual_write');
  });
});

describe('personaCoreDualWrite', () => {
  it('enqueuePersonaEvent inserts to outbox', () => {
    const db = makeDb();
    personaCoreDualWrite.enqueuePersonaEvent(
      db, 't1', 'persona:p1', 'persona.created', 'cmd-1', '{"id":"p1"}',
    );
    const rows = db.prepare('SELECT * FROM persona_core_ledger_outbox').all();
    assert.equal(rows.length, 1);
  });

  it('flushOutbox delivers to ledger and clears outbox', async () => {
    const db = makeDb();
    const ledger = new SqliteEventLedger(db);

    personaCoreDualWrite.enqueuePersonaEvent(
      db, 't1', 'persona:p2', 'persona.created', 'cmd-2', '{"id":"p2"}',
    );

    const result = await personaCoreDualWrite.flushOutbox(db, ledger);
    assert.equal(result.flushed, 1);
    assert.equal(result.failed, 0);

    const remaining = db.prepare('SELECT * FROM persona_core_ledger_outbox').all();
    assert.equal(remaining.length, 0);

    const events = await ledger.loadStream('t1', 'persona:p2');
    assert.equal(events.length, 1);
  });
});
