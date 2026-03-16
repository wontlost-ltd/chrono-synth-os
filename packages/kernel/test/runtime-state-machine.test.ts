import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeSessionState } from '../src/domain/persona/types.js';
import {
  ACTIVE_RUNTIME_STATES,
  TERMINAL_RUNTIME_STATES,
  isRuntimeTerminalState,
  computeRuntimeTimeoutAt,
  nextRuntimeRetryState,
  shouldRetryRuntimeSession,
} from '../src/domain/persona/runtime-state-machine.js';

const ALL_STATES: readonly RuntimeSessionState[] = [
  'PLAN', 'EXECUTE', 'EVALUATE', 'MEMORY_UPDATE', 'REPUTATION_UPDATE',
  'COMPLETED', 'FAILED', 'TIMEOUT', 'ERROR',
];

describe('runtime-state-machine', () => {
  describe('ACTIVE_RUNTIME_STATES / TERMINAL_RUNTIME_STATES', () => {
    it('active 与 terminal 互斥且覆盖全部状态', () => {
      for (const state of ALL_STATES) {
        const inActive = ACTIVE_RUNTIME_STATES.has(state);
        const inTerminal = TERMINAL_RUNTIME_STATES.has(state);
        assert.ok(inActive || inTerminal, `${state} 未归类`);
        assert.ok(!(inActive && inTerminal), `${state} 同时出现在 active 和 terminal`);
      }
    });

    it('active 包含 5 个状态', () => {
      assert.equal(ACTIVE_RUNTIME_STATES.size, 5);
    });

    it('terminal 包含 4 个状态', () => {
      assert.equal(TERMINAL_RUNTIME_STATES.size, 4);
    });
  });

  describe('isRuntimeTerminalState', () => {
    it('terminal 状态返回 true', () => {
      for (const state of ['COMPLETED', 'FAILED', 'TIMEOUT', 'ERROR'] as const) {
        assert.equal(isRuntimeTerminalState(state), true, `${state} 应为 terminal`);
      }
    });

    it('active 状态返回 false', () => {
      for (const state of ['PLAN', 'EXECUTE', 'EVALUATE', 'MEMORY_UPDATE', 'REPUTATION_UPDATE'] as const) {
        assert.equal(isRuntimeTerminalState(state), false, `${state} 不应为 terminal`);
      }
    });
  });

  describe('computeRuntimeTimeoutAt', () => {
    it('正常超时计算', () => {
      assert.equal(computeRuntimeTimeoutAt(1000, 5000), 6000);
    });

    it('强制最小 1000ms', () => {
      assert.equal(computeRuntimeTimeoutAt(1000, 0), 2000);
      assert.equal(computeRuntimeTimeoutAt(1000, 500), 2000);
      assert.equal(computeRuntimeTimeoutAt(1000, 999), 2000);
    });

    it('边界: sessionTimeoutMs = 1000 时取 1000', () => {
      assert.equal(computeRuntimeTimeoutAt(1000, 1000), 2000);
    });

    it('边界: sessionTimeoutMs = 1001 时取 1001', () => {
      assert.equal(computeRuntimeTimeoutAt(1000, 1001), 2001);
    });

    it('负值 sessionTimeoutMs 被 clamp 到 1000', () => {
      assert.equal(computeRuntimeTimeoutAt(1000, -500), 2000);
    });
  });

  describe('nextRuntimeRetryState', () => {
    it('任何状态重试都返回 PLAN', () => {
      for (const state of ALL_STATES) {
        assert.equal(nextRuntimeRetryState(state), 'PLAN');
      }
    });
  });

  describe('shouldRetryRuntimeSession', () => {
    it('retryCount < maxRetries 时允许重试', () => {
      assert.equal(shouldRetryRuntimeSession(0, 3), true);
      assert.equal(shouldRetryRuntimeSession(2, 3), true);
    });

    it('retryCount >= maxRetries 时不允许重试', () => {
      assert.equal(shouldRetryRuntimeSession(3, 3), false);
      assert.equal(shouldRetryRuntimeSession(5, 3), false);
    });

    it('maxRetries = 0 时永不重试', () => {
      assert.equal(shouldRetryRuntimeSession(0, 0), false);
    });

    it('边界: retryCount = 0, maxRetries = 1', () => {
      assert.equal(shouldRetryRuntimeSession(0, 1), true);
    });
  });
});
