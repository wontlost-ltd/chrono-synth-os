import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { personaCoreDualWrite } from '../../data-plane/persona-core-dual-write.js';
import { createMemoryDatabase, type IDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { DualWriteFlushWorker } from '../../workers/dual-write-flush-worker.js';

function makeDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

describe('DualWriteFlushWorker', () => {
  it('start() and stop() do not throw', () => {
    const db = makeDb();
    const worker = new DualWriteFlushWorker({ db, intervalMs: 60_000 });

    assert.doesNotThrow(() => worker.start());
    assert.doesNotThrow(() => worker.stop());
  });

  it('stop() called twice does not throw', () => {
    const db = makeDb();
    const worker = new DualWriteFlushWorker({ db, intervalMs: 60_000 });

    worker.start();

    assert.doesNotThrow(() => worker.stop());
    assert.doesNotThrow(() => worker.stop());
  });

  it('flush() with empty outbox returns zero counts', async () => {
    const db = makeDb();
    const worker = new DualWriteFlushWorker({ db });

    const result = await worker.flush();

    assert.deepEqual(result, { flushed: 0, failed: 0 });
  });

  it('flush() with one pending outbox entry returns one flushed entry', async () => {
    const db = makeDb();
    const worker = new DualWriteFlushWorker({ db });

    personaCoreDualWrite.enqueuePersonaEvent(
      db,
      'tenant-worker',
      'persona:worker-1',
      'persona.created',
      'cmd-worker-1',
      '{"id":"worker-1"}',
    );

    const result = await worker.flush();

    assert.deepEqual(result, { flushed: 1, failed: 0 });
  });

  it('flush() processes multiple outbox entries in one call', async () => {
    const db = makeDb();
    const worker = new DualWriteFlushWorker({ db });

    for (let i = 1; i <= 3; i++) {
      personaCoreDualWrite.enqueuePersonaEvent(
        db,
        'tenant-worker',
        `persona:worker-${i}`,
        'persona.created',
        `cmd-worker-${i}`,
        `{"id":"worker-${i}"}`,
      );
    }

    const result = await worker.flush();
    const remaining = db.prepare('SELECT * FROM persona_core_ledger_outbox').all();

    assert.deepEqual(result, { flushed: 3, failed: 0 });
    assert.equal(remaining.length, 0);
  });
});
