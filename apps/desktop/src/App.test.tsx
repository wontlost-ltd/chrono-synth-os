import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/* boot 序列桥接：getFirstRunCompleted 用变量驱动（first-run 回归测试要先 false 后 true）。 */
let firstRunCompleted = true;
vi.mock('@/bridge/tauri-commands', () => ({
  openDatabase: vi.fn().mockResolvedValue(undefined),
  getFirstRunCompleted: vi.fn(async () => firstRunCompleted),
}));

/* useTrayStatusSync 有独立测试（useTrayStatusSync.test.tsx）；这里 mock 成 no-op，让 App 测试
 * 不必引入 QueryClientProvider，专注「按 plan 选哪套 router」。 */
vi.mock('@/tray/useTrayStatusSync', () => ({
  useTrayStatusSync: vi.fn(),
}));

/* 把两套 router 换成轻量哨兵——App 测试只关心「选了哪套」，不关心页面内部（页面各有自己的测试）。 */
vi.mock('@/routers/EnterpriseRoutes', () => ({
  EnterpriseRoutes: () => <div data-testid="enterprise-router" />,
}));
vi.mock('@/routers/CompanionRoutes', () => ({
  CompanionRoutes: ({ plan }: { plan: string }) => (
    <div data-testid="companion-router" data-plan={plan} />
  ),
}));

/* OnboardingPage 换成哨兵：暴露一个按钮调用注入的 onComplete，用来驱动 App 的 first-run 完成逻辑
 * （完整向导流程由 OnboardingPage.test.tsx 覆盖，这里只验证 App 状态机对 onComplete 的反应）。 */
vi.mock('@/pages/OnboardingPage', () => ({
  OnboardingPage: ({ onComplete }: { onComplete?: () => void }) => (
    <button data-testid="onboarding" onClick={() => onComplete?.()}>
      finish-onboarding
    </button>
  ),
}));

vi.mock('@/plan/account-plan-runtime', () => ({
  resolveAccountPlan: vi.fn(),
}));

import { App } from './App';
import { resolveAccountPlan } from '@/plan/account-plan-runtime';

const resolvePlanMock = resolveAccountPlan as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resolvePlanMock.mockReset();
  firstRunCompleted = true;
});

describe('App plan-based router switch (ADR-0046 2.4a)', () => {
  it('plan=companion → 渲染 CompanionRoutes（并把 plan 透传）', async () => {
    resolvePlanMock.mockResolvedValue('companion');
    render(<App />);
    const router = await waitFor(() => screen.getByTestId('companion-router'));
    expect(router).toHaveAttribute('data-plan', 'companion');
    expect(screen.queryByTestId('enterprise-router')).not.toBeInTheDocument();
  });

  it('plan=enterprise → 渲染 EnterpriseRoutes', async () => {
    resolvePlanMock.mockResolvedValue('enterprise');
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('enterprise-router')).toBeInTheDocument());
    expect(screen.queryByTestId('companion-router')).not.toBeInTheDocument();
  });

  it('plan=unconfigured → 回退 EnterpriseRoutes（本地优先默认）', async () => {
    resolvePlanMock.mockResolvedValue('unconfigured');
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('enterprise-router')).toBeInTheDocument());
    expect(screen.queryByTestId('companion-router')).not.toBeInTheDocument();
  });
});

describe('App 启动状态机回归（Codex PR-A Critical）', () => {
  it('first-run：完成 onboarding 后重跑 boot 进入主应用，而非卡在 onboarding', async () => {
    firstRunCompleted = false; // 首次启动未 onboard
    resolvePlanMock.mockResolvedValue('enterprise');
    render(<App />);

    /* 先渲染 onboarding 哨兵。 */
    const finish = await waitFor(() => screen.getByTestId('onboarding'));

    /* 模拟 onboarding 内部已 markFirstRunCompleted，下次 boot 会读到 true。 */
    firstRunCompleted = true;
    fireEvent.click(finish);

    /* App 应 bump nonce 重跑 boot → 探测 plan → ready → 进入主应用（不再停在 onboarding）。 */
    await waitFor(() => expect(screen.getByTestId('enterprise-router')).toBeInTheDocument());
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument();
  });

  it('resolveAccountPlan 抛出 → App 不卡死，降级 unconfigured 进企业版', async () => {
    resolvePlanMock.mockRejectedValue(new Error('unexpected'));
    render(<App />);
    /* 即便解析抛错，App 也必须到达 ready 并渲染某套 router（这里是企业版兜底）。 */
    await waitFor(() => expect(screen.getByTestId('enterprise-router')).toBeInTheDocument());
  });
});
