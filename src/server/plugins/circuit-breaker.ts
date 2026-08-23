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
   * ⚠️ 该 flake 的**确切机制我没查明**，不要在此处臆测：
   * 我验过并**否掉**了三个假设 ——「setTimeout 提前触发」（200 次实测最小经过 20ms）、
   * 「复刻用例裸跑会红」（400 轮 0 失败）、「CPU 负载下 elapsed 会 <10ms」
   * （600 轮 0 失败、elapsed 最小 19ms）。
   *
   * 注入时钟的价值恰恰在于**不需要先查明机制**：把窗口判定与真实耗时解耦后，
   * 无论调度如何抖动，状态跃迁都由显式推进的时钟决定。
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
