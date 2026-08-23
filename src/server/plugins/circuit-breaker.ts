/**
 * 断路器插件 — 薄适配器，委托 kernel 纯函数
 * 保持原有 CircuitBreaker 类接口不变
 */

import {
  evaluateCircuitState,
  canExecute,
  recordHalfOpenAttempt,
  recordSuccess,
  recordFailure,
  INITIAL_CIRCUIT_SNAPSHOT,
  DEFAULT_CIRCUIT_BREAKER_OPTIONS,
  CircuitOpenError,
  CircuitTimeoutError,
} from '@chrono/kernel';
import type {
  CircuitState,
  CircuitBreakerOptions,
  CircuitBreakerSnapshot,
} from '@chrono/kernel';
import { realClock, type Clock } from '../../utils/clock.js';

export type { CircuitState, CircuitBreakerOptions };
export { CircuitOpenError, CircuitTimeoutError };

export class CircuitBreaker {
  private snapshot: CircuitBreakerSnapshot = { ...INITIAL_CIRCUIT_SNAPSHOT };
  private readonly opts: CircuitBreakerOptions;
  /** 状态跃迁判定用的时钟；未注入则用真实时钟（生产行为一字不变）。 */
  private readonly clock: Clock;

  /**
   * @param clock 可选时钟——**存在的理由是可测性**（issue #378）。
   *
   * 状态跃迁判据是 `now - lastFailureTime >= resetTimeoutMs`（kernel 纯函数），
   * 而本类此前三处都传裸 `Date.now()`。测试只能用「设 `resetTimeoutMs: 10`
   * 再 `setTimeout(20)` 去跨窗口」这种墙钟手法，实测**隔离重跑 5 次红 1 次**。
   *
   * 机制（已查明并确定性复现）：故障发生在 `setTimeout` **之前**，方向与直觉相反 ——
   * 不是「等了 20ms 还没跃迁」，而是**提前**跃迁。
   * `recordFailure(now)` 写下 lastFailureTime，紧随其后的 `getState()` 再取一次 now；
   * 二者间隔正常为 0ms，但偶发调度/GC 停顿会拉大（实测 4000 次采样：
   * p50=0、p99=0、max=373ms，`gap >= 10ms` 占 0.05%）。
   * 一旦该停顿 ≥ `resetTimeoutMs`，`elapsed >= resetTimeoutMs` 当场成立，
   * `getState()` 直接返回 half_open —— 于是**前置断言** `assert.equal(getState(), 'open')` 失败。
   *
   * 确定性复现（非概率采样）：`execute` 抛错后显式同步阻塞 12ms → `getState()` 必为
   * half_open；不阻塞 → 必为 open。
   *
   * 注入时钟根治它：同一逻辑时刻内 gap 恒为 0，跃迁只由显式推进的时钟决定。
   */
  constructor(opts?: Partial<CircuitBreakerOptions>, clock: Clock = realClock) {
    this.opts = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...opts };
    this.clock = clock;
  }

  /** 当前状态 */
  getState(): CircuitState {
    this.snapshot = evaluateCircuitState(this.snapshot, this.opts, this.clock.now());
    return this.snapshot.state;
  }

  /** 通过断路器执行操作 */
  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    this.snapshot = evaluateCircuitState(this.snapshot, this.opts, this.clock.now());

    if (!canExecute(this.snapshot, this.opts)) {
      throw new CircuitOpenError(
        this.snapshot.state === 'open'
          ? '断路器已打开，请求被拒绝'
          : '断路器半开状态，探测请求已满',
      );
    }

    this.snapshot = recordHalfOpenAttempt(this.snapshot);

    try {
      let result: T;
      if (this.opts.executionTimeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            Promise.resolve(fn()),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new CircuitTimeoutError(
                `操作超时（${this.opts.executionTimeoutMs}ms）`,
              )), this.opts.executionTimeoutMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else {
        result = await fn();
      }
      this.snapshot = recordSuccess(this.snapshot);
      return result;
    } catch (err) {
      this.snapshot = recordFailure(this.snapshot, this.opts, this.clock.now());
      throw err;
    }
  }

  /** 重置断路器到初始状态 */
  reset(): void {
    this.snapshot = { ...INITIAL_CIRCUIT_SNAPSHOT };
  }
}
