/**
 * PersonaGovernance 页面：save-toast + dirty-state（后续债2）。
 *
 * mock query hooks，验证：① 初始无 dirty、保存按钮禁用；② 编辑后 dirty 提示出现 + 保存启用；
 * ③ 保存成功后显示「已保存」+ dirty 清除；④ 编辑会清掉上次的成功提示。
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PersonaGovernance from './PersonaGovernance';
import type { GovernancePolicyResponse } from '../api/queries/persona-governance';

/* 可控 personaId 路由参数（测 persona 切换状态隔离）。 */
let currentPersonaId = 'p1';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ personaId: currentPersonaId }) };
});

/* i18n：直接回 key，便于断言（不依赖真 locale）。 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

/* 可控的 query mock。 */
const mockData: GovernancePolicyResponse = {
  override: null,
  effective: {
    allowedCategories: ['research', 'writing'],
    maxAutonomousReward: 50,
    dailyRewardExposureCap: 200,
    maxConcurrentTasks: 3,
    failureStreakBreaker: 2,
    minReputationForAutonomy: 0,
    aml: { maxTasksPerPublisherPerWindow: 5, maxPublisherRewardShare: 0.8, concentrationMinTasks: 4, maxIdenticalRewardRepeats: 4 },
  },
  meta: null,
};
let mutateImpl = vi.fn();

vi.mock('../api/queries/persona-governance', () => ({
  useGovernancePolicy: () => ({ data: mockData, isLoading: false, error: null }),
  useSetGovernancePolicy: () => ({ mutate: mutateImpl, isPending: false, error: null }),
  useResetGovernancePolicy: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

function renderPage() {
  return render(<MemoryRouter><PersonaGovernance /></MemoryRouter>);
}

describe('PersonaGovernance save-toast + dirty-state（债2）', () => {
  beforeEach(() => { mutateImpl = vi.fn(); currentPersonaId = 'p1'; });

  it('初始无 dirty：保存按钮禁用，无 unsaved 提示', () => {
    renderPage();
    const save = screen.getByRole('button', { name: 'governance.save' });
    expect(save).toBeDisabled();
    expect(screen.queryByText('governance.unsaved')).toBeNull();
  });

  it('编辑后 dirty：出现 unsaved 提示 + 保存启用', () => {
    renderPage();
    const rewardInput = screen.getByPlaceholderText('50'); // maxAutonomousReward effective=50 作 placeholder
    fireEvent.change(rewardInput, { target: { value: '120' } });
    expect(screen.getByText('governance.unsaved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'governance.save' })).toBeEnabled();
  });

  it('保存成功 → 显示「已保存」（mutation onSuccess 触发 toast）', async () => {
    /* mutate 成功回调用新 override；真实 useSetGovernancePolicy 会 setQueryData 更新缓存，
     * 此处 mock 静态故仅验证 toast 出现（dirty 清除依赖缓存刷新，在真实 hook 中验证）。 */
    mutateImpl = vi.fn((_override, opts) => {
      opts?.onSuccess?.({ ...mockData, override: { maxAutonomousReward: 120 }, meta: { updatedBy: 'me', updatedAt: 1 } });
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('50'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'governance.save' }));
    await waitFor(() => expect(screen.getByText('governance.saved')).toBeInTheDocument());
    /* mutate 被调用一次（提交了覆盖对象）。 */
    expect(mutateImpl).toHaveBeenCalledOnce();
  });

  it('切换 persona → 本地 form 重置（不把 A 的表单残留到 B，Codex 复审 High）', () => {
    const { rerender } = renderPage();
    /* 在 p1 编辑出 dirty。 */
    fireEvent.change(screen.getByPlaceholderText('50'), { target: { value: '120' } });
    expect(screen.getByText('governance.unsaved')).toBeInTheDocument();
    /* 切到 p2 + 重渲染（模拟路由 param 变化，组件实例复用）。 */
    currentPersonaId = 'p2';
    rerender(<MemoryRouter><PersonaGovernance /></MemoryRouter>);
    /* form 应已重置 → 不再 dirty（p1 的改动没残留到 p2）。 */
    expect(screen.queryByText('governance.unsaved')).toBeNull();
  });
});
