/**
 * Contract test: @chrono/adapter-tauri composes with the kernel via a
 * mock invoke() bridge. Demonstrates the host-supplied UoW pattern works
 * when persistence is delegated to Rust through Tauri commands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTables,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  TauriKVStore,
  type TauriInvoke,
} from '@chrono/adapter-tauri';
import { tpermCmdGrant, tpermQueryByPersonaTool } from '@chrono/kernel';

interface InvokeCall { readonly cmd: string; readonly args: Record<string, unknown> | undefined; }

function mockInvoke() {
  const calls: InvokeCall[] = [];
  let storage: unknown | null = null;
  const invoke: TauriInvoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'chrono_kv_load') return storage as T;
    if (cmd === 'chrono_kv_save') {
      storage = args?.['snapshot'];
      return undefined as T;
    }
    if (cmd === 'chrono_kv_clear') {
      storage = null;
      return undefined as T;
    }
    throw new Error(`unknown command: ${cmd}`);
  };
  return { invoke, calls, peek: () => storage };
}

describe('@chrono/adapter-tauri PoC', () => {
  it('TauriKVStore.load → invoke chrono_kv_load with key', async () => {
    const { invoke, calls } = mockInvoke();
    const store = new TauriKVStore({ invoke });
    const result = await store.load();
    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cmd, 'chrono_kv_load');
    assert.equal(calls[0]?.args?.['key'], 'snapshot');
  });

  it('TauriKVStore custom commands override defaults', async () => {
    const calls: InvokeCall[] = [];
    const invoke: TauriInvoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return undefined as T;
    };
    const store = new TauriKVStore({
      invoke,
      commands: { load: 'my_load', save: 'my_save', clear: 'my_clear' },
    });
    await store.save({ tables: {} });
    assert.equal(calls[0]?.cmd, 'my_save');
  });

  it('end-to-end: kernel write → TauriKVStore persists → fresh adapter rehydrates', async () => {
    const { invoke } = mockInvoke();

    const tablesA = new InMemoryTables();
    const registryA = createExecutorRegistry();
    registerToolPermissionExecutors(registryA);
    const storeA = new TauriKVStore({ invoke });
    const persistenceA = new WebPersistenceController(tablesA, storeA, { debounceMs: 5 });
    const txA = new WebUnitOfWork(tablesA, registryA);
    txA.onCommit(() => persistenceA.onCommit());

    txA.transaction(() => {
      txA.execute(tpermCmdGrant({
        id: 'tperm_tauri',
        tenantId: 'default',
        personaId: 'p1',
        toolId: 'web_search',
        scope: 'execute',
        constraintsJson: '{}',
        grantedBy: 'admin',
        now: 1700000000000,
        expiresAt: null,
        revocationKey: 'rk_tauri',
      }));
    });
    await persistenceA.flushNow();

    const tablesB = new InMemoryTables();
    const registryB = createExecutorRegistry();
    registerToolPermissionExecutors(registryB);
    const storeB = new TauriKVStore({ invoke });
    const persistenceB = new WebPersistenceController(tablesB, storeB);
    await persistenceB.hydrate();
    const txB = new WebUnitOfWork(tablesB, registryB);

    const row = txB.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default',
      personaId: 'p1',
      toolId: 'web_search',
    }));
    assert.ok(row, 'rehydrated kernel state should see the granted permission');
    assert.equal(row?.id, 'tperm_tauri');
  });
});
