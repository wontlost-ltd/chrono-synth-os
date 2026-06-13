/**
 * 端侧持久化（ADR-0052 Edge-P3）— 让端侧人格状态可落盘 + 重载 + replay 一致。
 *
 * `EdgePersistence` 是运行时中性接口：浏览器实现用 IndexedDB / OPFS，RN 用 SQLite/SecureStore，
 * 桌面 Tauri 用 SQLCipher。本模块提供 `InMemoryPersistence`（零 node:*、零外部依赖）作为 reference
 * 与测试实现，证明「持久化往返语义」——序列化 → 落盘 → 重载 → 状态 hash 一致。真平台 KV 后端是
 * 各 host 的实现细节，不进本可移植层。
 */

/** 端侧 KV 持久化接口（key→序列化字符串）。全 async 以兼容 IndexedDB 等异步后端。 */
export interface EdgePersistence {
  save(key: string, serialized: string): Promise<void>;
  load(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

/** 内存实现：零依赖 reference + 测试后端。可枚举 keys 供调试。 */
export class InMemoryPersistence implements EdgePersistence {
  private readonly store = new Map<string, string>();

  async save(key: string, serialized: string): Promise<void> {
    this.store.set(key, serialized);
  }

  async load(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}
