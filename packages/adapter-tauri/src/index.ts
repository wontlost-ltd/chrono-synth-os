/**
 * @chrono/adapter-tauri
 *
 * Tauri host adapter for @chrono/kernel. Composes @chrono/adapter-web's
 * in-memory + UoW pattern with a TauriKVStore that persists through Tauri
 * `invoke()` commands to the Rust side.
 */

export { TauriKVStore } from './tauri-kv-store.js';
export type { TauriKVStoreOptions, TauriInvoke } from './tauri-kv-store.js';

/* Re-export the kernel-facing pieces from adapter-web so Tauri hosts only
 * need to depend on @chrono/adapter-tauri. */
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
