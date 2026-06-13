/**
 * 端侧确定性 host adapter（ADR-0052 Edge-P2）— 非 Node runtime 的 reference 实现。
 *
 * 目的：证明 `@chrono/kernel` 的领域逻辑**只依赖注入的 host ports**，不偷偷依赖 Node 全局/API。
 * 这些 adapter **只用 ECMAScript 标准**（无 `node:*` import、无 process/Buffer/fs），因此可原样跑在
 * Web Worker / Tauri WebView / React Native Hermes 等非 Node runtime（ADR-0001 的可移植承诺）。
 *
 * 确定性：Clock 单调递增、Random 是种子序列——同种子 + 同操作序列 → 同 id/时间戳，支撑 golden replay
 * （为未来 WASM/MCU 确定性回放打基础）。生产端侧应换成真实 Clock（Date.now）/ Random（crypto.randomUUID），
 * 但本 reference 用确定性实现以便可验证。
 */

import type { KernelClock, KernelRandom } from '@chrono/kernel';

/** 确定性时钟：从 startMs 起每次 now() 递增 stepMs。可注入起点与步长。 */
export class DeterministicClock implements KernelClock {
  private current: number;
  constructor(startMs = 1_000, private readonly stepMs = 1_000) {
    this.current = startMs;
  }
  now(): number {
    const t = this.current;
    this.current += this.stepMs;
    return t;
  }
  /** 重置到起点（replay 用）。 */
  reset(startMs = 1_000): void {
    this.current = startMs;
  }
}

/** 确定性随机：种子化计数器生成可复现 uuid（非密码学，仅供 replay 证明）。 */
export class DeterministicRandom implements KernelRandom {
  private counter = 0;
  constructor(private readonly seed = 'edge') {}
  uuid(prefix?: string): string {
    const n = (this.counter++).toString(16).padStart(8, '0');
    /* 确定性「uuid 形」：seed + 计数，足以唯一且可复现。 */
    const body = `${this.seed}-${n}`;
    return prefix ? `${prefix}_${body}` : body;
  }
  /** 重置计数器（replay 用）。 */
  reset(): void {
    this.counter = 0;
  }
}
