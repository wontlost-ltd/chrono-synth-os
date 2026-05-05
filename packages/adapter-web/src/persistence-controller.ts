/**
 * Persistence loop: hydrate from WebKVStore at startup, debounce-write on commit.
 *
 * Debounce avoids a write storm when many transactions land in the same tick.
 * `flushNow()` forces a synchronous-ish flush — useful before tab unload.
 */

import type { InMemoryTables } from './in-memory-tables.js';
import type { WebKVStore } from './web-kv-store.js';

export interface PersistenceControllerOptions {
  /** Debounce window (ms). Defaults to 50. */
  readonly debounceMs?: number;
}

export class WebPersistenceController {
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly tables: InMemoryTables,
    private readonly store: WebKVStore,
    options: PersistenceControllerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 50;
  }

  async hydrate(): Promise<void> {
    const snapshot = await this.store.load();
    if (snapshot && typeof snapshot === 'object' && 'tables' in snapshot) {
      this.tables.hydrate(snapshot as ReturnType<InMemoryTables['serialize']>);
    }
  }

  onCommit(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  async flushNow(): Promise<void> {
    if (!this.dirty && !this.pending) return;
    if (this.pending) {
      await this.pending;
      if (!this.dirty) return;
    }
    this.dirty = false;
    const snapshot = this.tables.serialize();
    this.pending = this.store.save(snapshot).finally(() => {
      this.pending = null;
    });
    await this.pending;
  }

  async dispose(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) {
      await this.flushNow();
    } else if (this.pending) {
      await this.pending;
    }
  }
}
