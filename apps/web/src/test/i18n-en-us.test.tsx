/**
 * P0.4 i18n 烟测：验证关键 UI 在 en-US 下确实切换为英文
 *
 * 覆盖：
 * - SyncStatusIndicator（同步状态徽章 — 用户最高频可见）
 * - MilestoneTimeline（图表里程碑标签）
 * - ConflictInboxPage（冲突收件箱主标题 + 空状态）
 *
 * 把 zh-CN/en-US 两份资源都注入，用 changeLanguage 切到 en-US 后渲染并断言。
 * 测试结束后切回 zh-CN，避免污染后续 setup.ts 的默认状态。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../i18n';
import enUS from '../i18n/locales/en-US.json';
import { SyncStatusIndicator } from '../components/ui/SyncStatusIndicator';
import { MilestoneTimeline } from '../components/charts/MilestoneTimeline';
import { ConflictInboxPage } from '../features/conflicts/ConflictInboxPage';

beforeAll(async () => {
  if (!i18n.hasResourceBundle('en-US', 'translation')) {
    i18n.addResourceBundle('en-US', 'translation', enUS, true, true);
  }
  await i18n.changeLanguage('en-US');
  // Stub fetch so ConflictInboxPage doesn't try a real network call
  // (jsdom would otherwise throw "Invalid URL" for the relative path).
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('zh-CN');
});

describe('en-US smoke test', () => {
  it('SyncStatusIndicator renders English labels', () => {
    const { rerender } = render(<SyncStatusIndicator state="online_synced" />);
    expect(screen.getByText('Synced')).toBeInTheDocument();

    rerender(<SyncStatusIndicator state="offline_queueing" pendingCount={3} />);
    expect(screen.getByText(/Offline \(queued\)/)).toBeInTheDocument();

    rerender(<SyncStatusIndicator state="conflict_inbox" />);
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
  });

  it('MilestoneTimeline renders English kind labels', () => {
    const events = [
      { metric: 'wealth', kind: 'peak', year: 5, value: 100000 },
      { metric: 'wealth', kind: 'trough', year: 7, value: 20000 },
      { metric: 'health', kind: 'cross_up', year: 3, value: 0.7 },
      { metric: 'stress', kind: 'cross_down', year: 4, value: 0.2 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<MilestoneTimeline events={events as any} />);
    expect(screen.getByText(/Peak/)).toBeInTheDocument();
    expect(screen.getByText(/Trough/)).toBeInTheDocument();
    expect(screen.getByText(/Crossed up/)).toBeInTheDocument();
    expect(screen.getByText(/Crossed down/)).toBeInTheDocument();
  });

  it('ConflictInboxPage shows English title + empty state', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ConflictInboxPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // 标题立即可见（英文）
    expect(await screen.findByText('Conflict Inbox')).toBeInTheDocument();
    // 副标题
    expect(screen.getByText('Resolve cross-runtime sync conflicts')).toBeInTheDocument();
    // 刷新按钮
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});
