import { describe, it, expect } from 'vitest';
import { computeTrayStatus, computeTrayStatusLabel } from './tray-status';
import type { RuntimeSyncStateV2 } from '@chrono/contracts';

describe('computeTrayStatus', () => {
  it('在线 + drift ok（或无报告）→ 成长中', () => {
    expect(computeTrayStatus('ok', 'online_synced').kind).toBe('growing');
    expect(computeTrayStatus(null, 'online_synced').kind).toBe('growing');
  });

  it('在线 + warning → 探索活跃', () => {
    expect(computeTrayStatus('warning', 'online_synced').kind).toBe('exploring');
  });

  it('在线 + critical → 需关注', () => {
    expect(computeTrayStatus('critical', 'online_dirty').kind).toBe('attention');
  });

  it('离线类 sync 状态优先覆盖为离线（无视 drift 等级）', () => {
    const offlineStates: RuntimeSyncStateV2[] = [
      'offline_queueing',
      'offline_readonly',
      'degraded_remote',
      'recovery_required',
    ];
    for (const s of offlineStates) {
      /* 即便 drift=critical，离线时也显示离线（本地 drift 可能已过期）。 */
      expect(computeTrayStatus('critical', s).kind).toBe('offline');
    }
  });

  it('syncing / initial_sync / reauth 不算离线，按 drift 等级走', () => {
    expect(computeTrayStatus('ok', 'syncing').kind).toBe('growing');
    expect(computeTrayStatus('warning', 'initial_sync').kind).toBe('exploring');
    expect(computeTrayStatus('ok', 'reauth_required').kind).toBe('growing');
  });

  it('label 含状态点 emoji + 中文', () => {
    expect(computeTrayStatusLabel('ok', 'online_synced')).toContain('成长中');
    expect(computeTrayStatusLabel('critical', 'online_synced')).toContain('需关注');
    expect(computeTrayStatusLabel('ok', 'offline_readonly')).toContain('离线');
  });
});
