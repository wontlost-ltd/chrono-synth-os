import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/bridge/tauri-commands', () => ({
  getLatestDriftReport: vi.fn(),
  getSyncState: vi.fn(),
  pushTrayStatus: vi.fn().mockResolvedValue(undefined),
}));

import { getLatestDriftReport, getSyncState, pushTrayStatus } from '@/bridge/tauri-commands';
import { useTrayStatusSync } from './useTrayStatusSync';

const driftMock = getLatestDriftReport as unknown as ReturnType<typeof vi.fn>;
const syncMock = getSyncState as unknown as ReturnType<typeof vi.fn>;
const pushMock = pushTrayStatus as unknown as ReturnType<typeof vi.fn>;

/** 最近一次 pushTrayStatus 的 label 参数（避免用 Array.prototype.at，兼容 desktop tsconfig target）。 */
function lastPushedLabel(): string {
  const calls = pushMock.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

function syncRow(state: string) {
  return {
    id: 'singleton',
    state,
    network_online: true,
    auth_valid: true,
    remote_reachable: true,
    pending_push_count: 0,
    conflict_count: 0,
    last_sync_at: null,
    last_error: null,
    updated_at: 0,
  };
}

function Harness() {
  useTrayStatusSync();
  return null;
}

function renderHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<Harness />, { wrapper: Wrapper });
}

beforeEach(() => {
  driftMock.mockReset();
  syncMock.mockReset();
  pushMock.mockReset();
  pushMock.mockResolvedValue(undefined);
});

describe('useTrayStatusSync', () => {
  it('drift critical + 在线 → push「需关注」label', async () => {
    driftMock.mockResolvedValue({
      reportId: 'r', tenantId: 't', baselineSnapshotId: 's', analyzedAt: 1,
      overallDriftScore: 0.9, alertLevel: 'critical', valueDrifts: [],
    });
    syncMock.mockResolvedValue(syncRow('online_synced'));
    renderHarness();
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(lastPushedLabel()).toContain('需关注');
  });

  it('离线 sync 状态 → push「离线」label（无视 drift）', async () => {
    driftMock.mockResolvedValue({
      reportId: 'r', tenantId: 't', baselineSnapshotId: 's', analyzedAt: 1,
      overallDriftScore: 0.9, alertLevel: 'critical', valueDrifts: [],
    });
    syncMock.mockResolvedValue(syncRow('offline_readonly'));
    renderHarness();
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(lastPushedLabel()).toContain('离线');
  });

  it('无 drift 报告 + 在线 → push「成长中」', async () => {
    driftMock.mockResolvedValue(null);
    syncMock.mockResolvedValue(syncRow('online_synced'));
    renderHarness();
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(lastPushedLabel()).toContain('成长中');
  });
});
