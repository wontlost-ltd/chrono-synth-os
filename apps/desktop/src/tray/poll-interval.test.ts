import { describe, it, expect } from 'vitest';
import { computePollInterval, POLL_INTERVAL_MS } from './poll-interval';

describe('computePollInterval', () => {
  it('可见 + 插电 → active(30s)', () => {
    expect(computePollInterval({ visible: true, onBattery: false })).toBe(POLL_INTERVAL_MS.active);
  });

  it('可见 + 电池 → 60s', () => {
    expect(computePollInterval({ visible: true, onBattery: true })).toBe(
      POLL_INTERVAL_MS.visibleOnBattery,
    );
  });

  it('隐藏 + 插电 → 120s', () => {
    expect(computePollInterval({ visible: false, onBattery: false })).toBe(
      POLL_INTERVAL_MS.hiddenPlugged,
    );
  });

  it('隐藏 + 电池 → 300s（最省电，且不超过 5 分钟上限）', () => {
    const v = computePollInterval({ visible: false, onBattery: true });
    expect(v).toBe(POLL_INTERVAL_MS.hiddenOnBattery);
    expect(v).toBeLessThanOrEqual(300_000);
  });

  it('档位单调：可见≤隐藏、插电≤电池', () => {
    expect(POLL_INTERVAL_MS.active).toBeLessThanOrEqual(POLL_INTERVAL_MS.visibleOnBattery);
    expect(POLL_INTERVAL_MS.active).toBeLessThanOrEqual(POLL_INTERVAL_MS.hiddenPlugged);
    expect(POLL_INTERVAL_MS.visibleOnBattery).toBeLessThanOrEqual(POLL_INTERVAL_MS.hiddenOnBattery);
    expect(POLL_INTERVAL_MS.hiddenPlugged).toBeLessThanOrEqual(POLL_INTERVAL_MS.hiddenOnBattery);
  });
});
