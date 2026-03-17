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

export type { CircuitState, CircuitBreakerOptions };
export { CircuitOpenError, CircuitTimeoutError };

export class CircuitBreaker {
  private snapshot: CircuitBreakerSnapshot = { ...INITIAL_CIRCUIT_SNAPSHOT };
  private readonly opts: CircuitBreakerOptions;

  constructor(opts?: Partial<CircuitBreakerOptions>) {
    this.opts = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...opts };
  }

  /** 当前状态 */
  getState(): CircuitState {
    this.snapshot = evaluateCircuitState(this.snapshot, this.opts, Date.now());
    return this.snapshot.state;
  }

  /** 通过断路器执行操作 */
  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    this.snapshot = evaluateCircuitState(this.snapshot, this.opts, Date.now());

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
      this.snapshot = recordFailure(this.snapshot, this.opts, Date.now());
      throw err;
    }
  }

  /** 重置断路器到初始状态 */
  reset(): void {
    this.snapshot = { ...INITIAL_CIRCUIT_SNAPSHOT };
  }
}
