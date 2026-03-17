/**
 * 断路器 — 纯领域逻辑
 * 状态机：CLOSED → OPEN（达到失败阈值）→ HALF_OPEN（超时后探测）→ CLOSED/OPEN
 * 零 node:* 依赖，通过 KernelClock 注入时间源
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

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = Object.freeze({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxRequests: 1,
  executionTimeoutMs: 30_000,
});

/** 断路器状态快照（用于外部查询，不可变） */
export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastFailureTime: number;
  readonly halfOpenRequests: number;
}

/**
 * 评估状态转换（纯函数）
 * 如果当前为 OPEN 且已过重置超时，转换为 HALF_OPEN
 */
export function evaluateCircuitState(
  snapshot: CircuitBreakerSnapshot,
  opts: CircuitBreakerOptions,
  now: number,
): CircuitBreakerSnapshot {
  if (snapshot.state === 'open') {
    const elapsed = now - snapshot.lastFailureTime;
    if (elapsed >= opts.resetTimeoutMs) {
      return { ...snapshot, state: 'half_open', halfOpenRequests: 0 };
    }
  }
  return snapshot;
}

/**
 * 判断是否允许请求通过（纯函数）
 * 返回 true 表示允许，false 表示拒绝
 */
export function canExecute(snapshot: CircuitBreakerSnapshot, opts: CircuitBreakerOptions): boolean {
  if (snapshot.state === 'open') return false;
  if (snapshot.state === 'half_open' && snapshot.halfOpenRequests >= opts.halfOpenMaxRequests) return false;
  return true;
}

/**
 * 记录请求进入半开探测（纯函数）
 */
export function recordHalfOpenAttempt(snapshot: CircuitBreakerSnapshot): CircuitBreakerSnapshot {
  if (snapshot.state === 'half_open') {
    return { ...snapshot, halfOpenRequests: snapshot.halfOpenRequests + 1 };
  }
  return snapshot;
}

/**
 * 记录成功（纯函数）
 */
export function recordSuccess(snapshot: CircuitBreakerSnapshot): CircuitBreakerSnapshot {
  if (snapshot.state === 'half_open') {
    return { ...snapshot, state: 'closed', consecutiveFailures: 0, halfOpenRequests: 0 };
  }
  return { ...snapshot, consecutiveFailures: 0 };
}

/**
 * 记录失败（纯函数）
 */
export function recordFailure(
  snapshot: CircuitBreakerSnapshot,
  opts: CircuitBreakerOptions,
  now: number,
): CircuitBreakerSnapshot {
  const consecutiveFailures = snapshot.consecutiveFailures + 1;
  const lastFailureTime = now;

  if (snapshot.state === 'half_open') {
    return { ...snapshot, state: 'open', consecutiveFailures, lastFailureTime };
  }

  const state = consecutiveFailures >= opts.failureThreshold ? 'open' : snapshot.state;
  return { ...snapshot, state, consecutiveFailures, lastFailureTime };
}

/** 初始断路器快照 */
export const INITIAL_CIRCUIT_SNAPSHOT: CircuitBreakerSnapshot = Object.freeze({
  state: 'closed',
  consecutiveFailures: 0,
  lastFailureTime: 0,
  halfOpenRequests: 0,
});

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
