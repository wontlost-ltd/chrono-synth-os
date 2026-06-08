import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CompanionGrowthPage } from './CompanionGrowthPage';

vi.mock('@/bridge/tauri-commands', () => ({
  getLatestDriftReport: vi.fn(),
  queryTenantSnapshotCount: vi.fn(),
}));

import { getLatestDriftReport, queryTenantSnapshotCount } from '@/bridge/tauri-commands';

const driftMock = getLatestDriftReport as unknown as ReturnType<typeof vi.fn>;
const snapshotCountMock = queryTenantSnapshotCount as unknown as ReturnType<typeof vi.fn>;

/* 每个测试用全新 QueryClient + 关闭 retry，避免查询缓存/重试串扰断言。 */
function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  driftMock.mockReset();
  snapshotCountMock.mockReset();
});

describe('CompanionGrowthPage', () => {
  it('无可对比基线（<2 快照）→「还在认识你」空态', async () => {
    driftMock.mockResolvedValue(null);
    snapshotCountMock.mockResolvedValue(1);
    render(<CompanionGrowthPage />, { wrapper });
    await waitFor(() => {
      expect(screen.getByText(/还在认识你/)).toBeInTheDocument();
    });
  });

  it('有基线 → 把本地 drift 渲染成「探索方向」（toward/away + 强度），按幅度降序', async () => {
    snapshotCountMock.mockResolvedValue(3);
    driftMock.mockResolvedValue({
      reportId: 'r',
      tenantId: 't',
      baselineSnapshotId: 'snap',
      analyzedAt: 1_700_000_000_000,
      overallDriftScore: 0.5,
      alertLevel: 'warning',
      valueDrifts: [
        { valueId: 'a', label: '冒险', baseline: 0.2, current: 0.5, delta: 0.3, alertLevel: 'warning' },
        { valueId: 'b', label: '安稳', baseline: 0.8, current: 0.5, delta: -0.3, alertLevel: 'warning' },
        { valueId: 'd', label: '越界', baseline: 0, current: 1, delta: 1.5, alertLevel: 'critical' },
      ],
    });

    render(<CompanionGrowthPage />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText('冒险')).toBeInTheDocument();
    });
    /* 整体节奏来自 alertLevel=warning → exploring=「探索中」；逐条 warning 漂移也各有一个
     * 「探索中」徽标，故用 getAllByText（出现≥1次即证明强度映射生效）。 */
    expect(screen.getAllByText('探索中').length).toBeGreaterThanOrEqual(1);
    /* 方向标签：正 delta→越来越看重，负 delta→逐渐放下。 */
    expect(screen.getAllByText('越来越看重').length).toBeGreaterThan(0);
    expect(screen.getByText('逐渐放下')).toBeInTheDocument();

    /* 排序：magnitude 最大的「越界」（1.5 夹到 1）排在「冒险」「安稳」前面。 */
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('越界');
  });

  it('读取失败 → alert', async () => {
    snapshotCountMock.mockResolvedValue(3);
    driftMock.mockRejectedValue(new Error('db locked'));
    render(<CompanionGrowthPage />, { wrapper });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('db locked');
    });
  });
});
