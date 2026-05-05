/**
 * Contract test: @chrono/adapter-react-native composes with the kernel
 * via mock Expo SQLite / AsyncStorage drivers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTables,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  ExpoSQLiteKVStore,
  AsyncStorageKVStore,
  type ExpoSQLiteDatabaseLike,
  type AsyncStorageLike,
} from '@chrono/adapter-react-native';
import { tpermCmdGrant, tpermQueryByPersonaTool } from '@chrono/kernel';

function mockExpoDb(): ExpoSQLiteDatabaseLike {
  const rows = new Map<string, string>();
  return {
    async execAsync(_sql: string) { return undefined; },
    async runAsync(sql: string, ...params: unknown[]) {
      const upper = sql.toUpperCase();
      if (upper.startsWith('INSERT')) {
        rows.set(String(params[0]), String(params[1]));
      } else if (upper.startsWith('DELETE')) {
        rows.delete(String(params[0]));
      }
      return undefined;
    },
    async getFirstAsync<T>(_sql: string, ...params: unknown[]) {
      const v = rows.get(String(params[0]));
      return v ? ({ snapshot_json: v } as unknown as T) : null;
    },
  };
}

function mockAsyncStorage(): AsyncStorageLike {
  const rows = new Map<string, string>();
  return {
    async getItem(key: string) { return rows.get(key) ?? null; },
    async setItem(key: string, value: string) { rows.set(key, value); },
    async removeItem(key: string) { rows.delete(key); },
  };
}

describe('@chrono/adapter-react-native — ExpoSQLiteKVStore', () => {
  it('save/load round-trips a snapshot object', async () => {
    const store = new ExpoSQLiteKVStore({ db: mockExpoDb() });
    const snapshot = { tables: { core_values: { primaryKey: 'id', rows: [{ id: 'patience' }] } } };
    await store.save(snapshot);
    assert.deepEqual(await store.load(), snapshot);
  });

  it('clear removes the snapshot', async () => {
    const store = new ExpoSQLiteKVStore({ db: mockExpoDb() });
    await store.save({ tables: {} });
    await store.clear();
    assert.equal(await store.load(), null);
  });

  it('end-to-end: kernel write → SQLite persist → fresh adapter rehydrates', async () => {
    const db = mockExpoDb();

    const tablesA = new InMemoryTables();
    const registryA = createExecutorRegistry();
    registerToolPermissionExecutors(registryA);
    const storeA = new ExpoSQLiteKVStore({ db });
    const persistenceA = new WebPersistenceController(tablesA, storeA, { debounceMs: 5 });
    const txA = new WebUnitOfWork(tablesA, registryA);
    txA.onCommit(() => persistenceA.onCommit());

    txA.transaction(() => {
      txA.execute(tpermCmdGrant({
        id: 'tperm_rn',
        tenantId: 'default',
        personaId: 'p1',
        toolId: 'web_search',
        scope: 'execute',
        constraintsJson: '{}',
        grantedBy: 'admin',
        now: 1700000000000,
        expiresAt: null,
        revocationKey: 'rk_rn',
      }));
    });
    await persistenceA.flushNow();

    const tablesB = new InMemoryTables();
    const registryB = createExecutorRegistry();
    registerToolPermissionExecutors(registryB);
    const storeB = new ExpoSQLiteKVStore({ db });
    const persistenceB = new WebPersistenceController(tablesB, storeB);
    await persistenceB.hydrate();
    const txB = new WebUnitOfWork(tablesB, registryB);

    const row = txB.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default', personaId: 'p1', toolId: 'web_search',
    }));
    assert.equal(row?.id, 'tperm_rn');
  });
});

describe('@chrono/adapter-react-native — AsyncStorageKVStore', () => {
  it('save/load round-trips a snapshot object', async () => {
    const store = new AsyncStorageKVStore({ storage: mockAsyncStorage() });
    const snapshot = { tables: { tool_permissions: { primaryKey: 'id', rows: [] } } };
    await store.save(snapshot);
    assert.deepEqual(await store.load(), snapshot);
  });

  it('clear removes the snapshot', async () => {
    const store = new AsyncStorageKVStore({ storage: mockAsyncStorage() });
    await store.save({ tables: {} });
    await store.clear();
    assert.equal(await store.load(), null);
  });

  it('handles malformed JSON gracefully (returns null)', async () => {
    const storage = mockAsyncStorage();
    await storage.setItem('@chrono/snapshot', 'not-json{');
    const store = new AsyncStorageKVStore({ storage });
    assert.equal(await store.load(), null);
  });
});
