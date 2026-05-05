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

## IndexedDB binding

Shipped as `IndexedDbWebKVStore`. The factory is injected so the module never reaches for browser globals — that means tests can use polyfills.

```ts
import { IndexedDbWebKVStore } from '@chrono/adapter-web';

const store = new IndexedDbWebKVStore({
  dbName: 'chrono-persona',
  idb: indexedDB, // browser global; pass `self.indexedDB` from a Web Worker
});
```

Tests:

```ts
import 'fake-indexeddb/auto'; // shims `indexedDB` onto globalThis
import { IndexedDbWebKVStore } from '@chrono/adapter-web';

const store = new IndexedDbWebKVStore({ dbName: 't', idb: indexedDB });
```

The integration test at `src/test/integration/adapter-web-indexeddb.test.ts` covers the round-trip using `fake-indexeddb`.

## Trade-offs

- **Memory pressure**: full dataset lives in JS heap. Suitable for personas with up to ~100k rows; revisit if you store full conversation transcripts.
- **Persistence is best-effort and async**: the kernel commit returns synchronously, but the disk write happens later. Call `flushNow()` before unload (`window.beforeunload` / `navigator.locks.request`).
- **No partial loading**: hydration is an all-or-nothing snapshot read. If you need lazy table loading, either build a sharded `WebKVStore` or split datasets across kernel instances.

## Status

`0.1.0` — proof-of-concept covering `tool_permissions`. Adding more domains is mechanical: implement an executor file in `src/executors/`, mirror the SQLite executor's logic against `InMemoryTables`, register in `index.ts`.
