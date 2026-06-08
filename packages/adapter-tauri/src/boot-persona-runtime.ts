/**
 * Tauri 宿主的 persona runtime 组合启动器。
 *
 * 把 adapter-web 的 in-memory + UoW 模式与 TauriKVStore（经 Tauri `invoke()` 落到 Rust 侧）
 * 组装成一个可启动的 kernel runtime；没有 Rust 桥（如浏览器 `npm run dev`）时回退到内存存储，
 * 让 UI 仍可运行。
 *
 * 历史：本逻辑原在 apps/desktop 骨架（chrono-synth-desktop 融合时已弃，改走本地 SQLCipher +
 * HTTP）。迁来 adapter-tauri 作为正式包 API：保住「kernel-through-tauri 可启动」这一能力与回归，
 * 任何 Tauri 宿主想用「前端进程内嵌 kernel」模式都可直接复用，而不必再各自拼装。
 */

import {
  InMemoryTables,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  registerValueExecutors,
  type WebKVStore,
  type ExecutorRegistry,
} from '@chrono/adapter-web';
import { TauriKVStore, type TauriInvoke } from './tauri-kv-store.js';

export interface PersonaRuntime {
  readonly tx: WebUnitOfWork;
  readonly registry: ExecutorRegistry;
  readonly tables: InMemoryTables;
  readonly persistence: WebPersistenceController;
  /** Rust 侧 Tauri 处理器是否就绪；浏览器 dev 模式下为 false。 */
  readonly tauriBridgeAvailable: boolean;
}

/** 无 Tauri 桥时的内存回退存储，让 UI 在 Rust 处理器未接入时也能挂载。 */
class MemoryFallbackStore implements WebKVStore {
  private current: unknown | null = null;
  async load() { return this.current; }
  async save(snapshot: unknown) { this.current = snapshot; }
  async clear() { this.current = null; }
}

function detectTauriInvoke(): TauriInvoke | null {
  /* @tauri-apps/api 仅在 Tauri webview 内暴露 invoke；用动态属性探测避免浏览器 dev 的硬依赖。 */
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

  /* 页面卸载时尽力 flush，避免 Rust 侧丢失迟到写入。
   * 本包不引入 DOM lib（node 目标），故经 globalThis 弱类型访问 window，避免硬依赖 DOM 类型。 */
  const maybeWindow = (globalThis as unknown as {
    window?: { addEventListener?: (type: string, cb: () => void) => void };
  }).window;
  if (maybeWindow?.addEventListener) {
    maybeWindow.addEventListener('beforeunload', () => {
      void persistence.flushNow();
    });
  }

  return { tx, registry, tables, persistence, tauriBridgeAvailable };
}
