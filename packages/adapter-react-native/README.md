# @chrono/adapter-react-native

> React Native host adapter for `@chrono/kernel`. Composes `@chrono/adapter-web`'s in-memory + UoW machinery with two persistence stores: **Expo SQLite** (production) and **AsyncStorage** (prototyping).

License: MIT.

## Choose your store

| Store | Use when | Size cap |
|-------|----------|----------|
| `ExpoSQLiteKVStore` | Long-lived persona graphs, production apps | Bound by device storage |
| `AsyncStorageKVStore` | Prototypes, small personas | ~2 MB iOS, ~6 MB Android per value |

The kernel-facing surface is identical; pick the store that matches your storage budget.

## Quick start (Expo SQLite)

```ts
import * as SQLite from 'expo-sqlite';
import {
  InMemoryTables,
  WebUnitOfWork,
  WebPersistenceController,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  ExpoSQLiteKVStore,
} from '@chrono/adapter-react-native';

const db = await SQLite.openDatabaseAsync('chrono-persona.db');
const store = new ExpoSQLiteKVStore({ db });

const tables = new InMemoryTables();
const registry = createExecutorRegistry();
registerToolPermissionExecutors(registry);

const persistence = new WebPersistenceController(tables, store, { debounceMs: 50 });
await persistence.hydrate();

const tx = new WebUnitOfWork(tables, registry);
tx.onCommit(() => persistence.onCommit());
```

## Quick start (AsyncStorage)

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AsyncStorageKVStore } from '@chrono/adapter-react-native';

const store = new AsyncStorageKVStore({ storage: AsyncStorage });
// …rest is identical
```

## Why no expo / RN imports in this package?

The kernel-facing logic shouldn't pull in 100+ MB of RN tooling at build time. Both stores accept their backing driver through a structural type alias (`ExpoSQLiteDatabaseLike`, `AsyncStorageLike`); the host wires the real driver at runtime. CI builds in Node with no RN required.

## Status

`0.1.0` — JS side fully tested via in-memory mock drivers. Real RN runtime smoke tests live in your app, not in this package.
