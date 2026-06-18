/**
 * 主动性门控（ADR-0054 Phase 3）：纯函数「该不该开口」判定。
 * 验证抑制优先级 disabled > not_significant > quiet_period > rate_limited + emit。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProactiveGate,
  DEFAULT_PROACTIVE_GATE_CONFIG,
  type ProactiveGateConfig,
} from '../src/domain/persona/proactive-gate.js';

const CFG: ProactiveGateConfig = DEFAULT_PROACTIVE_GATE_CONFIG;

describe('evaluateProactiveGate（ADR-0054 主动性门控）', () => {
  it('显著信号 + 无历史 → emit', () => {
    const d = evaluateProactiveGate({
      signalType: 'core:memory-consolidated', now: 1_000_000, config: CFG,
      windowCount: 0, lastCreatedAt: null,
    });
    assert.equal(d.emit, true);
    assert.equal(d.reason, 'ok');
  });

  it('enabled=false → 一律 suppress（红线 3 总开关）', () => {
    const d = evaluateProactiveGate({
      signalType: 'core:memory-consolidated', now: 1_000_000,
      config: { ...CFG, enabled: false }, windowCount: 0, lastCreatedAt: null,
    });
    assert.equal(d.emit, false);
    assert.equal(d.reason, 'disabled');
  });

  it('静默期内（距上次不足 quietPeriodMs）→ suppress quiet_period', () => {
    const now = 1_000_000;
    const d = evaluateProactiveGate({
      signalType: 'core:narrative-changed', now, config: CFG,
      windowCount: 0, lastCreatedAt: now - (CFG.quietPeriodMs - 1),
    });
    assert.equal(d.emit, false);
    assert.equal(d.reason, 'quiet_period');
  });

  it('静默期已过 → emit', () => {
    const now = 1_000_000;
    const d = evaluateProactiveGate({
      signalType: 'core:narrative-changed', now, config: CFG,
      windowCount: 1, lastCreatedAt: now - (CFG.quietPeriodMs + 1),
    });
    assert.equal(d.emit, true);
  });

  it('频率上限已达 → suppress rate_limited', () => {
    const now = 1_000_000;
    const d = evaluateProactiveGate({
      signalType: 'system:evolution-completed', now, config: CFG,
      windowCount: CFG.maxPerWindow, lastCreatedAt: now - CFG.quietPeriodMs * 2,
    });
    assert.equal(d.emit, false);
    assert.equal(d.reason, 'rate_limited');
  });

  it('抑制优先级：disabled 先于其它', () => {
    /* 同时触发 disabled + 静默期 + 频率上限 → 报 disabled（最高优先级）。 */
    const now = 1_000_000;
    const d = evaluateProactiveGate({
      signalType: 'core:memory-consolidated', now,
      config: { ...CFG, enabled: false },
      windowCount: CFG.maxPerWindow, lastCreatedAt: now,
    });
    assert.equal(d.reason, 'disabled');
  });

  it('静默期优先于频率上限', () => {
    const now = 1_000_000;
    const d = evaluateProactiveGate({
      signalType: 'core:memory-consolidated', now, config: CFG,
      windowCount: CFG.maxPerWindow, lastCreatedAt: now - 1,
    });
    assert.equal(d.reason, 'quiet_period');
  });

  it('默认配置保守（红线 3）：静默期≥1h，窗口上限≤5', () => {
    assert.ok(DEFAULT_PROACTIVE_GATE_CONFIG.quietPeriodMs >= 60 * 60 * 1000);
    assert.ok(DEFAULT_PROACTIVE_GATE_CONFIG.maxPerWindow <= 5);
    assert.equal(DEFAULT_PROACTIVE_GATE_CONFIG.enabled, true);
  });
});
