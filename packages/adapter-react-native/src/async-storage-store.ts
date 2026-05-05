/**
 * AsyncStorage-backed WebKVStore.
 *
 * For small personas / quick prototypes. AsyncStorage has a per-value
 * size cap (~6 MB on Android, ~2 MB on iOS pre-bridge changes) so this
 * is not appropriate for long-lived persona graphs — prefer
 * ExpoSQLiteKVStore in production.
 */

import type { WebKVStore } from '@chrono/adapter-web';

/**
 * Structural alias for `@react-native-async-storage/async-storage`. Only
 * the methods we actually use; lets adopters bring their own polyfill.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface AsyncStorageKVStoreOptions {
  readonly storage: AsyncStorageLike;
  readonly key?: string;
}

export class AsyncStorageKVStore implements WebKVStore {
  private readonly storage: AsyncStorageLike;
  private readonly key: string;

  constructor(options: AsyncStorageKVStoreOptions) {
    this.storage = options.storage;
    this.key = options.key ?? '@chrono/snapshot';
  }

  async load(): Promise<unknown | null> {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async save(snapshot: unknown): Promise<void> {
    await this.storage.setItem(this.key, JSON.stringify(snapshot));
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(this.key);
  }
}
