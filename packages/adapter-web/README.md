# @chrono/adapter-web

> Web / Web Worker / Tauri host adapter for `@chrono/kernel`. Implements `SyncWriteUnitOfWork` over an in-memory table store with pluggable async persistence.

License: MIT.

## Why an in-memory mirror?

The kernel exposes a synchronous `SyncWriteUnitOfWork` port. IndexedDB, the only real browser storage with usable quotas, is **async-only** — there is no sync API. The adapter therefore:

1. Keeps the entire dataset in memory (`InMemoryTables`)
2. Implements the kernel's sync UoW by reading/writing that in-memory store
3. On every transaction commit, fires an event that an async controller (`WebPersistenceController`) handles by snapshotting the store and writing it to a `WebKVStore` (your IndexedDB adapter, `localStorage`, etc.)

The result is a strict implementation of the kernel contract that runs in a browser without deadlocking the event loop.

## Quick start

```ts
import {
  InMemoryTables,
  MemoryWebKVStore,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
} from '@chrono/adapter-web';

const tables = new InMemoryTables();
const registry = createExecutorRegistry();
registerToolPermissionExecutors(registry);

const store = new MemoryWebKVStore();          // swap for IndexedDbWebKVStore in production
const persistence = new WebPersistenceController(tables, store, { debounceMs: 50 });
await persistence.hydrate();

const tx = new WebUnitOfWork(tables, registry);
tx.onCommit(() => persistence.onCommit());

tx.transaction(() => {
  tx.execute(/* a kernel Command */);
});
await persistence.flushNow();                  // before tab unload
```

## IndexedDB adapter recipe

Implement `WebKVStore` against IndexedDB. Sketch:

```ts
import type { WebKVStore } from '@chrono/adapter-web';

export class IndexedDbWebKVStore implements WebKVStore {
  constructor(private readonly dbName: string, private readonly key = 'snapshot') {}

  async load() {
    const db = await openDb(this.dbName);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(this.key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(snapshot: unknown) { /* … objectStore.put(snapshot, this.key) … */ }
  async clear() { /* … objectStore.delete(this.key) … */ }
}
```

Why isn't this shipped in-package? CI runs in Node and would need `fake-indexeddb`. The adapter is small and host-specific; copy it.

## Trade-offs

- **Memory pressure**: full dataset lives in JS heap. Suitable for personas with up to ~100k rows; revisit if you store full conversation transcripts.
- **Persistence is best-effort and async**: the kernel commit returns synchronously, but the disk write happens later. Call `flushNow()` before unload (`window.beforeunload` / `navigator.locks.request`).
- **No partial loading**: hydration is an all-or-nothing snapshot read. If you need lazy table loading, either build a sharded `WebKVStore` or split datasets across kernel instances.

## Status

`0.1.0` — proof-of-concept covering `tool_permissions`. Adding more domains is mechanical: implement an executor file in `src/executors/`, mirror the SQLite executor's logic against `InMemoryTables`, register in `index.ts`.
