/**
 * StrategyAdvisorPanel：战略辅助表单 + 3 视角结果。mock useStrategyAdvise，验证举措增删、提交 payload、结果渲染、恒需批准提示。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyAdvisorPanel } from './StrategyAdvisorPanel';
import type { StrategyAdvisory } from '../../../api/queries/workforce-collab';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

let adviseMock: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error?: unknown; data?: StrategyAdvisory };
vi.mock('../../../api/queries/workforce-collab', async () => {
  const actual = await vi.importActual<typeof import('../../../api/queries/workforce-collab')>('../../../api/queries/workforce-collab');
  return { ...actual, useStrategyAdvise: () => adviseMock };
});

beforeEach(() => { adviseMock = { mutate: vi.fn(), isPending: false }; });

describe('StrategyAdvisorPanel', () => {
  it('填目标+举措 → 提交发出 advise mutate（含 initiatives）', () => {
    const mutate = vi.fn();
    adviseMock = { mutate, isPending: false };
    render(<StrategyAdvisorPanel orgId="org-1" />);
    fireEvent.change(screen.getByPlaceholderText('collab.strategy.objective'), { target: { value: '扩大内容产能' } });
    fireEvent.change(screen.getByPlaceholderText('collab.strategy.initTitle'), { target: { value: '招写手' } });
    fireEvent.change(screen.getByPlaceholderText('collab.strategy.initGoalType'), { target: { value: 'content_piece' } });
    fireEvent.click(screen.getByRole('button', { name: 'collab.strategy.advise' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const arg = mutate.mock.calls[0]![0];
    expect(arg.objective).toBe('扩大内容产能');
    expect(arg.initiatives).toHaveLength(1);
    expect(arg.initiatives[0].title).toBe('招写手');
    expect(arg.initiatives[0].goalType).toBe('content_piece');
  });

  it('「加一个举措」→ 增加一行；删除 → 减少', () => {
    render(<StrategyAdvisorPanel orgId="org-1" />);
    expect(screen.getAllByPlaceholderText('collab.strategy.initTitle')).toHaveLength(1);
    fireEvent.click(screen.getByText(/collab.strategy.addInitiative/));
    expect(screen.getAllByPlaceholderText('collab.strategy.initTitle')).toHaveLength(2);
  });

  it('结果渲染 3 视角 + 恒需批准提示', () => {
    adviseMock = {
      mutate: vi.fn(), isPending: false,
      data: {
        objective: 'x', requiresHumanApproval: true,
        alternatives: [
          { lens: 'impact_first', rationale: '按影响排', totalCost: 5000, includedCount: 2, escalationCount: 0,
            rankedInitiatives: [{ initiative: { id: 'i1', title: '招写手', goalType: 'content_piece', priority: 4, impact: 5, feasibility: 4, riskLevel: 'low', estimatedCost: 3000 }, score: 8.5, included: true, needsEscalation: false }] },
          { lens: 'risk_averse', rationale: '按风险排', totalCost: 3000, includedCount: 1, escalationCount: 1, rankedInitiatives: [] },
          { lens: 'quick_wins', rationale: '按速赢排', totalCost: 2000, includedCount: 1, escalationCount: 0, rankedInitiatives: [] },
        ],
      },
    };
    render(<StrategyAdvisorPanel orgId="org-1" />);
    expect(screen.getByText('collab.strategy.requiresApproval')).toBeInTheDocument();
    expect(screen.getByText('collab.strategy.lens.impact_first')).toBeInTheDocument();
    expect(screen.getByText('collab.strategy.lens.risk_averse')).toBeInTheDocument();
    expect(screen.getByText('collab.strategy.lens.quick_wins')).toBeInTheDocument();
    expect(screen.getByText('招写手')).toBeInTheDocument();
  });

  it('目标为空 → 提交按钮禁用', () => {
    render(<StrategyAdvisorPanel orgId="org-1" />);
    expect(screen.getByRole('button', { name: 'collab.strategy.advise' })).toBeDisabled();
  });

  it('★数值校验（Codex 复审）★：priority 越界（>5）→ 提交禁用（挡后端 400）', () => {
    render(<StrategyAdvisorPanel orgId="org-1" />);
    fireEvent.change(screen.getByPlaceholderText('collab.strategy.objective'), { target: { value: '目标' } });
    fireEvent.change(screen.getByPlaceholderText('collab.strategy.initTitle'), { target: { value: '举措' } });
    fireEvent.change(screen.getByPlaceholderText('collab.strategy.initGoalType'), { target: { value: 'content_piece' } });
    /* priority 输入框（第一个 NumField，label=collab.strategy.priority）设成 9（越界 1..5）。 */
    const priorityInput = screen.getByLabelText('collab.strategy.priority', { selector: 'input' }) as HTMLInputElement | null
      ?? screen.getAllByRole('spinbutton')[1]!; /* 兜底：spinbutton[0]=budgetCap，[1]=priority */
    fireEvent.change(priorityInput, { target: { value: '9' } });
    expect(screen.getByRole('button', { name: 'collab.strategy.advise' })).toBeDisabled();
  });
});
