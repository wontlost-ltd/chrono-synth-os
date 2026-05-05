/**
 * Desktop persona runtime — wires @chrono/adapter-tauri to a Tauri-hosted Rust backend.
 *
 * Hosts that don't yet have the Rust handlers wired (i.e., running `npm run dev`
 * without `cargo tauri dev`) get an in-memory fallback so the UI stays usable.
 */

import {
  InMemoryTables,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  registerValueExecutors,
  TauriKVStore,
  type WebKVStore,
  type ExecutorRegistry,
  type TauriInvoke,
} from '@chrono/adapter-tauri';

export interface PersonaRuntime {
  readonly tx: WebUnitOfWork;
  readonly registry: ExecutorRegistry;
  readonly tables: InMemoryTables;
  readonly persistence: WebPersistenceController;
  /** True when the Rust-side Tauri handlers were detected; false when running in browser dev mode. */
  readonly tauriBridgeAvailable: boolean;
}

/**
 * In-memory fallback for `npm run dev` (no Tauri bridge). Lets the UI mount
 * without crashing while the Rust handlers are being built.
 */
class MemoryFallbackStore implements WebKVStore {
  private current: unknown | null = null;
  async load() { return this.current; }
  async save(snapshot: unknown) { this.current = snapshot; }
  async clear() { this.current = null; }
}

function detectTauriInvoke(): TauriInvoke | null {
  /* @tauri-apps/api exposes `invoke` only inside a Tauri webview. Probing via
   * dynamic property avoids a hard dependency for browser-only dev runs. */
  const tauri = (globalThis as unknown as { __TAURI__?: { core?: { invoke?: TauriInvoke } } }).__TAURI__;
  return tauri?.core?.invoke ?? null;
}

export async function bootPersonaRuntime(): Promise<PersonaRuntime> {
  const invoke = detectTauriInvoke();
  const tauriBridgeAvailable = invoke !== null;
  const store: WebKVStore = invoke !== null
    ? new TauriKVStore({ invoke })
    : new MemoryFallbackStore();

  const tables = new InMemoryTables();
  const registry = createExecutorRegistry();
  registerToolPermissionExecutors(registry);
  registerValueExecutors(registry);

  const persistence = new WebPersistenceController(tables, store, { debounceMs: 50 });
  await persistence.hydrate();

  const tx = new WebUnitOfWork(tables, registry);
  tx.onCommit(() => persistence.onCommit());

  /* Best-effort flush on page unload so the Rust side doesn't lose late writes. */
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      void persistence.flushNow();
    });
  }

  return { tx, registry, tables, persistence, tauriBridgeAvailable };
}
