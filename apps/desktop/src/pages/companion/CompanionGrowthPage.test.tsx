import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CompanionGrowthPage } from './CompanionGrowthPage';

vi.mock('@/companion/growth-data', () => ({
  loadCompanionGrowth: vi.fn(),
}));

import { loadCompanionGrowth } from '@/companion/growth-data';

const loadMock = loadCompanionGrowth as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const growthWithBaseline = {
  schemaVersion: 'companion-growth.v1' as const,
  hasBaseline: true,
  analyzedAt: 1_700_000_000_000,
  overallIntensity: 'exploring' as const,
  directions: [
    { valueId: 'a', label: '冒险', direction: 'toward' as const, magnitude: 1, intensity: 'leaping' as const },
    { valueId: 'b', label: '安稳', direction: 'away' as const, magnitude: 0.3, intensity: 'exploring' as const },
  ],
};

beforeEach(() => loadMock.mockReset());

describe('CompanionGrowthPage（② 路线 B：在线取 + 缓存）', () => {
  it('未配置服务器且无缓存 → 引导去设置', async () => {
    loadMock.mockResolvedValue({ growth: null, source: 'none', unconfigured: true });
    render(<CompanionGrowthPage />, { wrapper });
    await waitFor(() => expect(screen.getByText(/还没连接服务器/)).toBeInTheDocument());
  });

  it('有基线（remote）→ 渲染探索方向 + 「在线最新」', async () => {
    loadMock.mockResolvedValue({ growth: growthWithBaseline, source: 'remote', unconfigured: false });
    render(<CompanionGrowthPage />, { wrapper });
    await waitFor(() => expect(screen.getByText('冒险')).toBeInTheDocument());
    expect(screen.getByText('越来越看重')).toBeInTheDocument();
    expect(screen.getByText('逐渐放下')).toBeInTheDocument();
    expect(screen.getByText(/在线最新/)).toBeInTheDocument();
  });

  it('缓存来源 → 显示「上次同步」离线提示', async () => {
    loadMock.mockResolvedValue({ growth: growthWithBaseline, source: 'cache', unconfigured: false });
    render(<CompanionGrowthPage />, { wrapper });
    await waitFor(() => expect(screen.getByText(/上次同步/)).toBeInTheDocument());
  });

  it('hasBaseline=false → 「还在认识你」空态', async () => {
    loadMock.mockResolvedValue({
      growth: { schemaVersion: 'companion-growth.v1', hasBaseline: false, analyzedAt: null, overallIntensity: 'steady', directions: [] },
      source: 'remote',
      unconfigured: false,
    });
    render(<CompanionGrowthPage />, { wrapper });
    await waitFor(() => expect(screen.getByText(/还在认识你/)).toBeInTheDocument());
  });
});
