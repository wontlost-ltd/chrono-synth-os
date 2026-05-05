/**
 * Tauri-backed WebKVStore.
 *
 * Persists the kernel snapshot through a Tauri command pair the host wires
 * up. The Rust side typically:
 *  - holds a JSON blob in app config dir, or
 *  - decomposes the snapshot into a SQLite database
 *
 * Either way, the JS side just calls `invoke('chrono_kv_load' | 'chrono_kv_save'
 * | 'chrono_kv_clear', { key })`. This adapter abstracts the Tauri-specific
 * API behind an injectable `TauriInvoke` so the same code is testable in
 * Node without pulling in `@tauri-apps/api`.
 */

import type { WebKVStore } from '@chrono/adapter-web';

export type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriKVStoreOptions {
  readonly invoke: TauriInvoke;
  readonly key?: string;
  /** Tauri command names; allow override for hosts using non-default naming. */
  readonly commands?: {
    readonly load?: string;
    readonly save?: string;
    readonly clear?: string;
  };
}

const DEFAULT_COMMANDS = {
  load: 'chrono_kv_load',
  save: 'chrono_kv_save',
  clear: 'chrono_kv_clear',
} as const;

export class TauriKVStore implements WebKVStore {
  private readonly key: string;
  private readonly cmd: { load: string; save: string; clear: string };

  constructor(private readonly options: TauriKVStoreOptions) {
    this.key = options.key ?? 'snapshot';
    this.cmd = {
      load: options.commands?.load ?? DEFAULT_COMMANDS.load,
      save: options.commands?.save ?? DEFAULT_COMMANDS.save,
      clear: options.commands?.clear ?? DEFAULT_COMMANDS.clear,
    };
  }

  async load(): Promise<unknown | null> {
    const result = await this.options.invoke<unknown>(this.cmd.load, { key: this.key });
    return result === undefined ? null : result;
  }

  async save(snapshot: unknown): Promise<void> {
    await this.options.invoke(this.cmd.save, { key: this.key, snapshot });
  }

  async clear(): Promise<void> {
    await this.options.invoke(this.cmd.clear, { key: this.key });
  }
}
