/**
 * Storage abstraction for the web adapter.
 *
 * IndexedDB is async-only, so a strict implementation of SyncWriteUnitOfWork
 * cannot block on it. The adapter keeps a fully-loaded in-memory snapshot and
 * flushes that snapshot to a WebKVStore on every transaction commit.
 *
 * Implementations of WebKVStore:
 *   - MemoryWebKVStore: pure in-memory; useful for tests and PoC
 *   - IndexedDbWebKVStore: documented in README; not part of the compiled
 *     package because CI runs under Node and would need fake-indexeddb to
 *     exercise it. Implementers can copy the contract from this file.
 */

export interface WebKVStore {
  /** Hydrate the snapshot. Resolve `null` if no snapshot has been stored yet. */
  load(): Promise<unknown | null>;
  /** Persist the latest snapshot. Implementations decide eviction / quota policy. */
  save(snapshot: unknown): Promise<void>;
  /** Remove the snapshot. */
  clear(): Promise<void>;
}

export class MemoryWebKVStore implements WebKVStore {
  private current: unknown | null = null;

  async load(): Promise<unknown | null> {
    return this.current;
  }

  async save(snapshot: unknown): Promise<void> {
    this.current = structuredClone(snapshot);
  }

  async clear(): Promise<void> {
    this.current = null;
  }
}
