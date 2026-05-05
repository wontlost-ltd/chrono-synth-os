/**
 * @chrono/adapter-react-native
 *
 * React Native host adapter for @chrono/kernel. Two store options:
 *
 *   - ExpoSQLiteKVStore  (Production: durable, larger payloads)
 *   - AsyncStorageKVStore (Prototyping: small datasets, fewer setup steps)
 *
 * Composes @chrono/adapter-web's in-memory + UoW machinery. RN-specific
 * dependencies are provided by the host (no expo-sqlite / RN imports
 * here — keeps Node CI buildable).
 */

export { ExpoSQLiteKVStore } from './expo-sqlite-store.js';
export type { ExpoSQLiteKVStoreOptions, ExpoSQLiteDatabaseLike } from './expo-sqlite-store.js';
export { AsyncStorageKVStore } from './async-storage-store.js';
export type { AsyncStorageKVStoreOptions, AsyncStorageLike } from './async-storage-store.js';

/* Re-export adapter-web's UoW machinery so RN hosts only depend on this package. */
export {
  InMemoryTables,
  WebUnitOfWork,
  WebPersistenceController,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  registerValueExecutors,
  registerMemoryExecutors,
  registerNarrativeExecutors,
  registerDecisionStyleExecutors,
} from '@chrono/adapter-web';
export type {
  WebKVStore,
  ExecutorRegistry,
  QueryHandler,
  CommandHandler,
  CommitListener,
} from '@chrono/adapter-web';
