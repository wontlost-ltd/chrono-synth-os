/**
 * EarningPage：数字人自主赚钱页。mock query hooks，验证钱包渲染、赚钱周期按钮、429 限流提示、收益流水空态。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EarningPage from './EarningPage';
import { ApiError } from '../../../api/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../../../hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

/* 固定一个 persona 列表（选择器默认选第一个）。 */
vi.mock('../../../api/queries/personaCore', () => ({
  usePersonaCoreList: () => ({ data: [{ id: 'p1', displayName: '数字人甲' }], isLoading: false }),
}));

let walletMock: { data?: unknown; isLoading: boolean; error?: unknown } = { data: undefined, isLoading: true };
let feedMock: { data?: unknown; isLoading: boolean; error?: unknown } = { data: undefined, isLoading: true };
let runCycleMock: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error?: unknown; data?: unknown } = { mutate: vi.fn(), isPending: false };

vi.mock('../../../api/queries/earning', () => ({
  useEarningWallet: () => walletMock,
  useEarningFeed: () => feedMock,
  useRunEarningCycle: () => runCycleMock,
}));

function renderPage() {
  return render(<MemoryRouter><EarningPage /></MemoryRouter>);
}

describe('EarningPage', () => {
  beforeEach(() => {
    walletMock = { data: { walletId: 'w1', balance: 128.5, tokenBalance: 42, currency: 'USD', withdrawalPolicy: 'human_confirmation_required' }, isLoading: false };
    feedMock = { data: { tasks: [], total: 0 }, isLoading: false };
    runCycleMock = { mutate: vi.fn(), isPending: false };
  });

  it('渲染钱包余额 + token 余额 + 提现说明', () => {
    renderPage();
    expect(screen.getByText(/128\.50/)).toBeInTheDocument();
    expect(screen.getByText(/42\.00/)).toBeInTheDocument();
    expect(screen.getByText('earning.wallet.withdrawalNote')).toBeInTheDocument();
  });

  it('点「运行一轮」触发赚钱周期 mutate', () => {
    const mutate = vi.fn();
    runCycleMock = { mutate, isPending: false };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'earning.cycle.run' }));
    expect(mutate).toHaveBeenCalledWith({});
  });

  it('cycle 429 限流 → 显示明确的限流提示（不是裸错误）', () => {
    runCycleMock = { mutate: vi.fn(), isPending: false, error: new ApiError(429, 'rate limited') };
    renderPage();
    expect(screen.getByText('earning.errors.rateLimited')).toBeInTheDocument();
  });

  it('收益流水为空 → 空态', () => {
    feedMock = { data: { tasks: [], total: 0 }, isLoading: false };
    renderPage();
    expect(screen.getByText('earning.feed.empty')).toBeInTheDocument();
  });

  it('收益流水有任务 → 渲染标题 + 报酬', () => {
    feedMock = {
      data: { total: 1, tasks: [{ id: 't1', title: '写一篇博客', category: 'writing', reward: 50, currency: 'USD', status: 'accepted', qualityScore: null, acceptedAt: null, completedAt: null }] },
      isLoading: false,
    };
    renderPage();
    expect(screen.getByText('写一篇博客')).toBeInTheDocument();
    expect(screen.getByText(/50\.00 USD/)).toBeInTheDocument();
  });
});
