/**
 * IndexedDB binding for WebKVStore.
 *
 * Reference implementation. Hosts may use this directly (browsers, Web
 * Workers) or copy it for environments that need a custom IDB shim.
 *
 * Why pluggable IDB factory: browsers expose `indexedDB` on window/self,
 * but tests run in Node and need an injected polyfill (e.g., fake-indexeddb).
 * Pass the factory at construction so this module never reaches for globals.
 */

import type { WebKVStore } from './web-kv-store.js';

const STORE_NAME = 'kv';

/**
 * Structural alias for the browser `IDBFactory`. Avoids forcing consumers
 * (or test runners that don't include the DOM lib) to pull in DOM types.
 * Pass `indexedDB` from a browser, `self.indexedDB` from a Web Worker, or
 * `new (await import('fake-indexeddb')).IDBFactory()` from a Node test.
 */
export interface IDBFactoryLike {
  open(name: string, version?: number): unknown;
}

export interface IndexedDbWebKVStoreOptions {
  readonly dbName: string;
  readonly key?: string;
  /** IDB factory. Browsers pass `indexedDB`; tests pass a polyfill. */
  readonly idb: IDBFactoryLike;
}

export class IndexedDbWebKVStore implements WebKVStore {
  private readonly key: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly options: IndexedDbWebKVStoreOptions) {
    this.key = options.key ?? 'snapshot';
  }

  async load(): Promise<unknown | null> {
    const db = await this.openDb();
    return new Promise<unknown | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(this.key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error ?? new Error('IDB get failed'));
    });
  }

  async save(snapshot: unknown): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(snapshot, this.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB put failed'));
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(this.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB delete failed'));
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.options.idb.open(this.options.dbName, 1) as IDBOpenDBRequest;
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    });
    return this.dbPromise;
  }
}
