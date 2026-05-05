/**
 * Integration test: @chrono/adapter-web IndexedDbWebKVStore via fake-indexeddb.
 *
 * Validates the recipe documented in packages/adapter-web/README.md works
 * end-to-end: hydrate / save / clear, plus a full kernel round-trip
 * through the WebUnitOfWork.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import {
  IndexedDbWebKVStore,
  InMemoryTables,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
} from '@chrono/adapter-web';
import { tpermCmdGrant, tpermQueryByPersonaTool } from '@chrono/kernel';

/** Each test gets its own fake-indexeddb factory for isolation. */
function freshFactory() {
  return new FakeIDBFactory();
}

describe('@chrono/adapter-web IndexedDbWebKVStore (fake-indexeddb)', () => {
  it('save then load round-trips a snapshot object', async () => {
    const idb = freshFactory();
    const store = new IndexedDbWebKVStore({
      dbName: 'chrono-test-rt',
      idb,
    });
    const snapshot = { tables: { tool_permissions: { primaryKey: 'id', rows: [{ id: 'tperm_1', toolId: 'web_search' }] } } };
    await store.save(snapshot);
    const loaded = await store.load();
    assert.deepEqual(loaded, snapshot);
  });

  it('clear removes the snapshot', async () => {
    const idb = freshFactory();
    const store = new IndexedDbWebKVStore({ dbName: 'chrono-test-clear', idb });
    await store.save({ tables: {} });
    await store.clear();
    const loaded = await store.load();
    assert.equal(loaded, null);
  });

  it('full kernel round-trip: grant via WebUoW → IDB persist → fresh adapter rehydrates', async () => {
    const idb = freshFactory();
    const dbName = 'chrono-test-roundtrip';

    /* Adapter A: writes the grant */
    const tablesA = new InMemoryTables();
    const registryA = createExecutorRegistry();
    registerToolPermissionExecutors(registryA);
    const storeA = new IndexedDbWebKVStore({ dbName, idb });
    const persistenceA = new WebPersistenceController(tablesA, storeA, { debounceMs: 5 });
    const txA = new WebUnitOfWork(tablesA, registryA);
    txA.onCommit(() => persistenceA.onCommit());

    txA.transaction(() => {
      txA.execute(tpermCmdGrant({
        id: 'tperm_idb',
        tenantId: 'default',
        personaId: 'p1',
        toolId: 'calendar',
        scope: 'execute',
        constraintsJson: '{}',
        grantedBy: 'admin',
        now: 1700000000000,
        expiresAt: null,
        revocationKey: 'rk_idb',
      }));
    });
    await persistenceA.flushNow();

    /* Adapter B: hydrates from the same IDB store */
    const tablesB = new InMemoryTables();
    const registryB = createExecutorRegistry();
    registerToolPermissionExecutors(registryB);
    const storeB = new IndexedDbWebKVStore({ dbName, idb });
    const persistenceB = new WebPersistenceController(tablesB, storeB);
    await persistenceB.hydrate();
    const txB = new WebUnitOfWork(tablesB, registryB);

    const row = txB.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default',
      personaId: 'p1',
      toolId: 'calendar',
    }));
    assert.ok(row, 'expected the granted permission to be visible after rehydration');
    assert.equal(row?.id, 'tperm_idb');
    assert.equal(row?.scope, 'execute');
    assert.equal(row?.revocation_key, 'rk_idb');
  });
});
