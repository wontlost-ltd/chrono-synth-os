import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { personaCoreDualWrite } from '../../data-plane/persona-core-dual-write.js';
import { createMemoryDatabase, type IDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { DualWriteFlushWorker } from '../../workers/dual-write-flush-worker.js';

function makeDb(): IDatabase {
  const db = createMemoryDatabase();
  runMigrations(db);
  return db;
}

describe('DualWriteFlushWorker', () => {
  it('start() and stop() do not throw', () => {
    const db = makeDb();
    const worker = new DualWriteFlushWorker({ db, intervalMs: 60_000 });

    assert.doesNotThrow(() => worker.start());
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
});
