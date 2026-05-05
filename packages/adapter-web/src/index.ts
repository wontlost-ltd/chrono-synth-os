/**
 * @chrono/adapter-web
 *
 * Browser / Web Worker / Tauri-friendly host adapter for @chrono/kernel.
 * Implements SyncWriteUnitOfWork over an in-memory table store with
 * pluggable persistence (WebKVStore — defaults to in-memory; users supply
 * an IndexedDB adapter at runtime, see README).
 */

export { MemoryWebKVStore } from './web-kv-store.js';
export type { WebKVStore } from './web-kv-store.js';
export { InMemoryTables, DEFAULT_TABLE_SCHEMA } from './in-memory-tables.js';
export type { Row, TableSchema, SerializedSnapshot, SerializedTable } from './in-memory-tables.js';
export {
  WebUnitOfWork,
  createExecutorRegistry,
} from './web-unit-of-work.js';
export type {
  ExecutorRegistry,
  QueryHandler,
  CommandHandler,
  CommitListener,
} from './web-unit-of-work.js';
export { WebPersistenceController } from './persistence-controller.js';
export type { PersistenceControllerOptions } from './persistence-controller.js';

export { registerToolPermissionExecutors } from './executors/tool-permission-executors.js';
