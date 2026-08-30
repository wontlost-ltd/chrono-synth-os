import type { RuntimeSessionState } from './types.js';

const activeRuntimeStates = new Set<RuntimeSessionState>([
  'PLAN',
  'EXECUTE',
  'EVALUATE',
  'MEMORY_UPDATE',
  'REPUTATION_UPDATE',
]);

const terminalRuntimeStates = new Set<RuntimeSessionState>([
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'ERROR',
]);

export const ACTIVE_RUNTIME_STATES: ReadonlySet<RuntimeSessionState> = activeRuntimeStates;
export const TERMINAL_RUNTIME_STATES: ReadonlySet<RuntimeSessionState> = terminalRuntimeStates;

export function isRuntimeTerminalState(state: RuntimeSessionState): boolean {
  return terminalRuntimeStates.has(state);
}

/**
 * ⚠️ issue #395 起**不再用于生产路径**：runtime_sessions 的 `timeout_at`
 * 已改由数据库算（`${dbNowMs(db)} + ?`，收时长），因为写入端与判定端
 * （RuntimeRecoveryWorker）跑在不同副本上，应用侧算好的绝对时刻会被钟差平移。
 *
 * 保留此函数仅为纯函数语义的既有单测；**新代码不要用它算落库的截止时刻**，
 * 否则就把「应用侧时钟」又塞回了跨副本判定链。
 */
export function computeRuntimeTimeoutAt(now: number, sessionTimeoutMs: number): number {
  return now + Math.max(1_000, sessionTimeoutMs);
}

export function nextRuntimeRetryState(_state: RuntimeSessionState): RuntimeSessionState {
  return 'PLAN';
}

export function shouldRetryRuntimeSession(retryCount: number, maxRetries: number): boolean {
  return retryCount < maxRetries;
}
