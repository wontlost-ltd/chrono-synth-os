import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/* boot 序列桥接：mock 成「空但成功」，让 App 测试聚焦在「按 plan 选哪套 router」这一个行为。 */
vi.mock('@/bridge/tauri-commands', () => ({
  openDatabase: vi.fn().mockResolvedValue(undefined),
  getFirstRunCompleted: vi.fn().mockResolvedValue(true),
}));

/* 把两套 router 换成轻量哨兵——App 测试只关心「选了哪套」，不关心页面内部（页面各有自己的测试）。
 * 这样无需把企业版/companion 整条渲染链路的桥接都 mock 全，隔离更干净、更不易碎。 */
vi.mock('@/routers/EnterpriseRoutes', () => ({
  EnterpriseRoutes: () => <div data-testid="enterprise-router" />,
}));
vi.mock('@/routers/CompanionRoutes', () => ({
  CompanionRoutes: ({ plan }: { plan: string }) => (
    <div data-testid="companion-router" data-plan={plan} />
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
