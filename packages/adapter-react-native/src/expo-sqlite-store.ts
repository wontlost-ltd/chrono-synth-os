/**
 * Expo SQLite-backed WebKVStore.
 *
 * Persists the kernel snapshot as a single JSON blob in a one-row table.
 * Suitable for personas with up to ~100k rows (the same memory ceiling as
 * the web adapter). For larger datasets, build a sharded variant that
 * splits per-domain.
 *
 * The Expo SQLite handle is injected to keep this package free of
 * @expo/* / react-native dependencies — that way TypeScript builds in
 * Node CI, and host apps own the version pin for their RN runtime.
 */

import type { WebKVStore } from '@chrono/adapter-web';

/**
 * Structural alias for the async API exposed by `expo-sqlite/next`'s
 * `SQLiteDatabase`. We only depend on the methods we actually call so
 * adopters can bring their own driver if they prefer.
 */
export interface ExpoSQLiteDatabaseLike {
  execAsync(sql: string): Promise<unknown>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getFirstAsync<T = unknown>(sql: string, ...params: unknown[]): Promise<T | null>;
}

const TABLE_NAME = 'chrono_kv';

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  key TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL
)`;

export interface ExpoSQLiteKVStoreOptions {
  readonly db: ExpoSQLiteDatabaseLike;
  readonly key?: string;
}

interface SnapshotRow {
  readonly snapshot_json: string;
}

export class ExpoSQLiteKVStore implements WebKVStore {
  private readonly key: string;
  private readonly db: ExpoSQLiteDatabaseLike;
  private initPromise: Promise<void> | null = null;

  constructor(options: ExpoSQLiteKVStoreOptions) {
    this.db = options.db;
    this.key = options.key ?? 'snapshot';
  }

  async load(): Promise<unknown | null> {
    await this.ensureInitialized();
    const row = await this.db.getFirstAsync<SnapshotRow>(
      `SELECT snapshot_json FROM ${TABLE_NAME} WHERE key = ?`,
      this.key,
    );
    if (!row) return null;
    try {
      return JSON.parse(row.snapshot_json);
    } catch {
      return null;
    }
  }

  async save(snapshot: unknown): Promise<void> {
    await this.ensureInitialized();
    const payload = JSON.stringify(snapshot);
    await this.db.runAsync(
      `INSERT INTO ${TABLE_NAME} (key, snapshot_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      this.key,
      payload,
    );
  }

  async clear(): Promise<void> {
    await this.ensureInitialized();
    await this.db.runAsync(`DELETE FROM ${TABLE_NAME} WHERE key = ?`, this.key);
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.db.execAsync(CREATE_TABLE_SQL).then(() => undefined);
    }
    return this.initPromise;
  }
}
