/**
 * WorkforceConsole 页面（E2 只读治理控制台）：mock workforce query hooks，验证渲染数字员工/目标/信号。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import WorkforceConsole from './WorkforceConsole';

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

/* 可控的 query mock。 */
const mockChart = vi.fn();
const mockGoals = vi.fn();
const mockSignal = vi.fn();
vi.mock('../api/queries/workforce', () => ({
  useOrgChart: () => mockChart(),
  useOrgGoals: () => mockGoals(),
  useWorkerPersonaSignal: () => mockSignal(),
}));

function renderConsole() {
  return render(<MemoryRouter><WorkforceConsole /></MemoryRouter>);
}

describe('WorkforceConsole（E2 只读控制台）', () => {
  beforeEach(() => {
    mockChart.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockGoals.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockSignal.mockReturnValue({ data: undefined, isLoading: false, error: null });
  });

  it('未选组织 → 提示选择', () => {
    renderConsole();
    expect(screen.getByText('选择一个组织')).toBeTruthy();
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
      data: { workerId: 'w1', decisionConfidence: 'high', confidenceRationale: '稳定交付', collaborationReach: 2, shouldReport: false, operating: { workerId: 'w1', activeTaskCount: 0, deliveredTaskCount: 3, blockedTaskCount: 0, highRiskTaskCount: 0, load: 'normal', needsAttention: false } },
      isLoading: false, error: null,
    });

    renderConsole();
    /* 输入 org 并查看。 */
    fireEvent.change(screen.getByPlaceholderText('输入组织 ID'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('查看'));

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
      data: { workerId: 'w1', decisionConfidence: 'low', confidenceRationale: '有 1 个阻塞任务', collaborationReach: 0, shouldReport: true, operating: { workerId: 'w1', activeTaskCount: 1, deliveredTaskCount: 0, blockedTaskCount: 1, highRiskTaskCount: 0, load: 'heavy', needsAttention: true } },
      isLoading: false, error: null,
    });
    renderConsole();
    fireEvent.change(screen.getByPlaceholderText('输入组织 ID'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('查看'));
    expect(screen.getAllByText(/需关注/).length).toBeGreaterThan(0);
  });

  it('chart 出错 → 错误态', () => {
    mockChart.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    mockGoals.mockReturnValue({ data: [], isLoading: false, error: null });
    renderConsole();
    fireEvent.change(screen.getByPlaceholderText('输入组织 ID'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('查看'));
    expect(screen.getAllByText('boom').length).toBeGreaterThan(0);
  });
});
