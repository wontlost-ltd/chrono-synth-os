import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/* 锁住本次 bugfix 的核心回归点：reload 必须在 setApiCredentials / clearCachedAccountPlan
 * **resolve 之后**才触发——否则 webview reload 会中断清缓存 promise（Codex 复审 Major）。 */
vi.mock('@/bridge/http-client', () => ({
  getApiBaseUrl: vi.fn(() => 'https://api.example.com'),
  getApiToken: vi.fn(() => 'jwt-x'),
  setApiToken: vi.fn(),
  setApiCredentials: vi.fn(),
  clearCachedAccountPlan: vi.fn(),
}));

import { CompanionSettingsPage } from './CompanionSettingsPage';
import { setApiCredentials, clearCachedAccountPlan } from '@/bridge/http-client';

const setCredsMock = setApiCredentials as unknown as ReturnType<typeof vi.fn>;
const clearPlanMock = clearCachedAccountPlan as unknown as ReturnType<typeof vi.fn>;

let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  reloadMock = vi.fn();
  /* jsdom 的 window.location.reload 不可直接赋值，用 defineProperty 覆盖。 */
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: reloadMock },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompanionSettingsPage 凭据更新顺序（reload 在事务后）', () => {
  it('保存：setApiCredentials 仍 pending 时不 reload，resolve 后才 reload', async () => {
    let resolveCreds: () => void = () => {};
    setCredsMock.mockReturnValue(new Promise<void>((r) => { resolveCreds = r; }));

    render(<CompanionSettingsPage plan="companion" />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    /* 事务未完成 → 绝不能已经 reload。 */
    await Promise.resolve();
    expect(setCredsMock).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();

    resolveCreds();
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });

  it('登出：clearCachedAccountPlan 仍 pending 时不 reload，resolve 后才 reload', async () => {
    let resolveClear: () => void = () => {};
    clearPlanMock.mockReturnValue(new Promise<void>((r) => { resolveClear = r; }));

    render(<CompanionSettingsPage plan="companion" />);
    fireEvent.click(screen.getByRole('button', { name: '登出' }));

    await Promise.resolve();
    expect(clearPlanMock).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();

    resolveClear();
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });
});
