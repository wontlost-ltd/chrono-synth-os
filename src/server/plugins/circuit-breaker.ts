/**
 * 断路器插件
 * 保护依赖调用（如数据库操作）在连续失败后自动断开，避免雪崩
 *
 * 状态机：CLOSED → OPEN（达到失败阈值）→ HALF_OPEN（超时后探测）→ CLOSED/OPEN
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** 触发断开的连续失败次数阈值 */
  readonly failureThreshold: number;
  /** 从 OPEN 进入 HALF_OPEN 的等待毫秒数 */
  readonly resetTimeoutMs: number;
  /** 半开状态下允许通过的探测请求数 */
  readonly halfOpenMaxRequests: number;
  /** 单次操作超时毫秒数（0 = 不限制） */
  readonly executionTimeoutMs: number;
}

const DEFAULTS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxRequests: 1,
  executionTimeoutMs: 30_000,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private halfOpenRequests = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts?: Partial<CircuitBreakerOptions>) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** 当前状态 */
  getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  /** 通过断路器执行操作 */
  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === 'open') {
      throw new CircuitOpenError('断路器已打开，请求被拒绝');
    }

    if (this.state === 'half_open' && this.halfOpenRequests >= this.opts.halfOpenMaxRequests) {
      throw new CircuitOpenError('断路器半开状态，探测请求已满');
    }

    if (this.state === 'half_open') {
      this.halfOpenRequests++;
    }

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
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** 重置断路器到初始状态 */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.halfOpenRequests = 0;
  }

  private evaluateState(): void {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.opts.resetTimeoutMs) {
        this.state = 'half_open';
        this.halfOpenRequests = 0;
      }
    }
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.consecutiveFailures = 0;
      this.halfOpenRequests = 0;
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      this.state = 'open';
    } else if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
    }
  }
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitTimeoutError extends Error {
  readonly code = 'CIRCUIT_TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'CircuitTimeoutError';
  }
}
