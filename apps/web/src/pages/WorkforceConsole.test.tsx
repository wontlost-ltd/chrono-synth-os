/**
 * WorkforceConsole 页面（E2 只读治理控制台）：mock workforce query hooks，验证渲染数字员工/目标/信号。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import WorkforceConsole from './WorkforceConsole';

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

/* i18n：t() 直接回 key，便于断言（不依赖真 locale）。 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

/* 可控的 query mock。 */
const mockChart = vi.fn();
const mockGoals = vi.fn();
const mockSignal = vi.fn();
const mockGoalTypes = vi.fn();
const mockPending = vi.fn();
const mockRunGoal = vi.fn();
const mockDecide = vi.fn();
vi.mock('../api/queries/workforce', () => ({
  useOrgChart: () => mockChart(),
  useOrgGoals: () => mockGoals(),
  useWorkerPersonaSignal: () => mockSignal(),
  useGoalTypes: () => mockGoalTypes(),
  usePendingApprovals: () => mockPending(),
  useRunGoal: () => mockRunGoal(),
  useDecideApproval: () => mockDecide(),
}));

function renderConsole() {
  return render(<MemoryRouter><WorkforceConsole /></MemoryRouter>);
}

describe('WorkforceConsole（E2 只读控制台）', () => {
  beforeEach(() => {
    mockChart.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockGoals.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockSignal.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockGoalTypes.mockReturnValue({ data: [{ goalType: 'content_piece', qualityRubric: [] }], isLoading: false, error: null });
    mockPending.mockReturnValue({ data: [], isLoading: false, error: null });
    mockRunGoal.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, isSuccess: false, data: undefined, error: null });
    mockDecide.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  });

  it('未选组织 → 提示选择', () => {
    renderConsole();
    expect(screen.getByText('workforce.selectOrgTitle')).toBeTruthy();
  });

  it('选组织后渲染数字员工 + 运营人格信号（决策置信度/负载）', () => {
    mockChart.mockReturnValue({
      data: {
        orgId: 'org-1',
        positions: [{ id: 'pos', orgId: 'org-1', title: '数字主编', jobFamily: 'manager', seniority: 'lead', roleCode: 'managing_editor' }],
        reportingEdges: [],
        workers: [{ id: 'w1', orgId: 'org-1', personaId: 'p', positionId: 'pos', displayName: '主编', employmentStatus: 'active' }],
      },
      isLoading: false, error: null,
    });
    mockGoals.mockReturnValue({ data: [{ id: 'g1', orgId: 'org-1', ownerWorkerId: 'w1', title: '咖啡指南', description: '', goalType: 'content_piece', status: 'completed', createdAt: 1, updatedAt: 1 }], isLoading: false, error: null });
    mockSignal.mockReturnValue({
      data: { workerId: 'w1', decisionConfidence: 'high', confidenceRationale: '稳定交付', collaborationReach: 2, shouldReport: false, operating: { workerId: 'w1', activeTaskCount: 0, deliveredTaskCount: 3, blockedTaskCount: 0, highRiskTaskCount: 0, overdueTaskCount: 0, dueSoonTaskCount: 0, load: 'normal', needsAttention: false } },
      isLoading: false, error: null,
    });

    renderConsole();
    /* 输入 org 并查看。 */
    fireEvent.change(screen.getByPlaceholderText('workforce.orgIdPlaceholder'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('workforce.view'));

    /* DataTable 可能同时渲染桌面表格 + 移动卡片 → 用 getAllByText（≥1）。 */
    expect(screen.getAllByText('主编').length).toBeGreaterThan(0);
    expect(screen.getAllByText('咖啡指南').length).toBeGreaterThan(0);
    /* 决策置信度（运营语言，非心情）。 */
    expect(screen.getAllByText('high').length).toBeGreaterThan(0);
    /* 岗位也展示（Codex 复审：岗位+信号）。 */
    expect(screen.getAllByText('数字主编').length).toBeGreaterThan(0);
    /* 只读控制台（Codex 复审）：没有委派/执行/创建等写操作按钮。 */
    for (const label of ['委派', '执行', '创建', '删除']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('worker 需关注 → 显示 ⚠ 提示', () => {
    mockChart.mockReturnValue({
      data: { orgId: 'org-1', positions: [], reportingEdges: [], workers: [{ id: 'w1', orgId: 'org-1', personaId: 'p', positionId: 'pos', displayName: 'A', employmentStatus: 'active' }] },
      isLoading: false, error: null,
    });
    mockGoals.mockReturnValue({ data: [], isLoading: false, error: null });
    mockSignal.mockReturnValue({
      data: { workerId: 'w1', decisionConfidence: 'low', confidenceRationale: '有 1 个阻塞任务', collaborationReach: 0, shouldReport: true, operating: { workerId: 'w1', activeTaskCount: 1, deliveredTaskCount: 0, blockedTaskCount: 1, highRiskTaskCount: 0, overdueTaskCount: 0, dueSoonTaskCount: 0, load: 'heavy', needsAttention: true } },
      isLoading: false, error: null,
    });
    renderConsole();
    fireEvent.change(screen.getByPlaceholderText('workforce.orgIdPlaceholder'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('workforce.view'));
    expect(screen.getAllByText(/workforce.needsAttention/).length).toBeGreaterThan(0);
  });

  it('chart 出错 → 错误态', () => {
    mockChart.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    mockGoals.mockReturnValue({ data: [], isLoading: false, error: null });
    renderConsole();
    fireEvent.change(screen.getByPlaceholderText('workforce.orgIdPlaceholder'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('workforce.view'));
    expect(screen.getAllByText('boom').length).toBeGreaterThan(0);
  });

  /** 进操作 tab（先选组织、切到 actions）。 */
  function openActions() {
    renderConsole();
    fireEvent.change(screen.getByPlaceholderText('workforce.orgIdPlaceholder'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('workforce.view'));
    fireEvent.click(screen.getByText('workforce.actionsTab'));
  }

  it('E3 操作 tab：发起目标表单 + 待审批区渲染', () => {
    openActions();
    expect(screen.getAllByText('workforce.initiateGoalSection').length).toBeGreaterThan(0);
    expect(screen.getAllByText('workforce.pendingApprovalsSection').length).toBeGreaterThan(0);
    /* goal type 下拉含后端返回的类型。 */
    expect(screen.getByText('content_piece')).toBeTruthy();
  });

  it('E3 发起目标：填完 manager+标题+类型 → 点按钮调 runGoal.mutate', () => {
    const mutate = vi.fn();
    mockRunGoal.mockReturnValue({ mutate, isPending: false, isError: false, isSuccess: false, data: undefined, error: null });
    openActions();
    fireEvent.change(screen.getByPlaceholderText('workforce.managerWorkerIdLabel'), { target: { value: 'w-mgr' } });
    fireEvent.change(screen.getByPlaceholderText('workforce.goalTitleLabel'), { target: { value: '咖啡指南' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'content_piece' } });
    fireEvent.click(screen.getByText('workforce.runGoal'));
    expect(mutate).toHaveBeenCalledWith({ managerWorkerId: 'w-mgr', title: '咖啡指南', description: '', goalType: 'content_piece' });
  });

  it('E3 待审批：approve high 风险 → 确认后调 decide.mutate（approve）', () => {
    const mutate = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true); /* 高风险 approve 二次确认 → 同意 */
    mockPending.mockReturnValue({
      data: [{ id: 'ap-1', tenantId: 't', orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: 'w1', effectiveRisk: 'high', requiresHuman: true, approvalMode: 'human_only', status: 'pending', approverWorkerId: null, approverUserId: null, reason: '高风险', correlationId: null, createdAt: 1, expiresAt: null, decidedAt: null }],
      isLoading: false, error: null,
    });
    mockDecide.mockReturnValue({ mutate, isPending: false, isError: false });
    openActions();
    /* DataTable 桌面+移动各渲一份按钮 → 取第一个 approve。 */
    fireEvent.click(screen.getAllByText('workforce.approve')[0]!);
    expect(mutate).toHaveBeenCalledWith({ approvalId: 'ap-1', decision: 'approve' });
  });

  it('★防误点★：approve high 风险确认弹窗取消 → 不调 mutate', () => {
    const mutate = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false); /* 取消 */
    mockPending.mockReturnValue({
      data: [{ id: 'ap-1', tenantId: 't', orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: 'w1', effectiveRisk: 'high', requiresHuman: true, approvalMode: 'human_only', status: 'pending', approverWorkerId: null, approverUserId: null, reason: '高风险', correlationId: null, createdAt: 1, expiresAt: null, decidedAt: null }],
      isLoading: false, error: null,
    });
    mockDecide.mockReturnValue({ mutate, isPending: false, isError: false });
    openActions();
    fireEvent.click(screen.getAllByText('workforce.approve')[0]!);
    expect(mutate).not.toHaveBeenCalled();
  });
});
