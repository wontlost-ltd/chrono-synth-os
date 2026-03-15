import type { RuntimeSessionState } from './types.js';

export const ACTIVE_RUNTIME_STATES = new Set<RuntimeSessionState>([
  'PLAN',
  'EXECUTE',
  'EVALUATE',
  'MEMORY_UPDATE',
  'REPUTATION_UPDATE',
]);

export const TERMINAL_RUNTIME_STATES = new Set<RuntimeSessionState>([
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'ERROR',
]);

export function isRuntimeTerminalState(state: RuntimeSessionState): boolean {
  return TERMINAL_RUNTIME_STATES.has(state);
}

export function computeRuntimeTimeoutAt(now: number, sessionTimeoutMs: number): number {
  return now + Math.max(1_000, sessionTimeoutMs);
}

export function nextRuntimeRetryState(_state: RuntimeSessionState): RuntimeSessionState {
  return 'PLAN';
}

export function shouldRetryRuntimeSession(retryCount: number, maxRetries: number): boolean {
  return retryCount < maxRetries;
}
