/**
 * DecisionsPage：决策模拟闭环。mock query hooks，验证列表渲染、建决策校验、模拟结果排序展示、429 限流提示。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DecisionsPage from './DecisionsPage';
import { ApiError } from '../../../api/client';
import type { DecisionCase, DecisionResult, DecisionListEnvelope } from '../../../api/queries/decisions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

let listMock: { data?: DecisionListEnvelope; isLoading: boolean; error?: unknown };
let createMock: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error?: unknown };
let simulateMock: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error?: unknown; data?: { runId: string; result: DecisionResult } };
const feedbackMock = { mutate: vi.fn(), isPending: false, isSuccess: false, error: null as unknown };

vi.mock('../../../api/queries/decisions', async () => {
  const actual = await vi.importActual<typeof import('../../../api/queries/decisions')>('../../../api/queries/decisions');
  return {
    ...actual,
    useDecisions: () => listMock,
    useCreateDecision: () => createMock,
    useSimulateDecision: () => simulateMock,
    useDecisionFeedback: () => feedbackMock,
  };
});

const dec: DecisionCase = { id: 'dec1', title: '换工作还是留下', description: '要不要跳槽', alternatives: ['跳槽', '留下'] };

beforeEach(() => {
  listMock = { data: { data: [dec], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }, isLoading: false };
  createMock = { mutate: vi.fn(), isPending: false };
  simulateMock = { mutate: vi.fn(), isPending: false };
});

describe('DecisionsPage', () => {
  it('渲染决策列表', () => {
    render(<DecisionsPage />);
    expect(screen.getByText('换工作还是留下')).toBeInTheDocument();
  });

  it('建决策：备选<2 时提交禁用；填够后可提交', () => {
    render(<DecisionsPage />);
    fireEvent.change(screen.getByPlaceholderText('decisions.create.title'), { target: { value: '决策' } });
    fireEvent.change(screen.getByPlaceholderText('decisions.create.description'), { target: { value: '描述' } });
    fireEvent.change(screen.getByPlaceholderText('decisions.create.alternatives'), { target: { value: '只有一个' } });
    expect(screen.getByRole('button', { name: 'decisions.create.submit' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('decisions.create.alternatives'), { target: { value: 'A\nB' } });
    expect(screen.getByRole('button', { name: 'decisions.create.submit' })).toBeEnabled();
  });

  it('选中决策 → 点模拟 → simulate mutate', () => {
    const mutate = vi.fn();
    simulateMock = { mutate, isPending: false };
    render(<DecisionsPage />);
    fireEvent.click(screen.getByText('换工作还是留下'));
    fireEvent.click(screen.getByRole('button', { name: 'decisions.simulate' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('模拟结果渲染推荐 + 排序（overall/regret）+ 反馈表单', () => {
    simulateMock = {
      mutate: vi.fn(), isPending: false,
      data: {
        runId: 'run1',
        result: {
          caseId: 'dec1', recommendedAlternative: '跳槽', simulatedAt: 1,
          rankedOptions: [
            { alternative: '跳槽', rank: 1, alignmentScore: 0.8, riskScore: 0.3, confidence: 0.9, overallScore: 0.85, regretProbability: 0.15 },
            { alternative: '留下', rank: 2, alignmentScore: 0.5, riskScore: 0.6, confidence: 0.7, overallScore: 0.55, regretProbability: 0.6 },
          ],
        },
      },
    };
    render(<DecisionsPage />);
    fireEvent.click(screen.getByText('换工作还是留下'));
    expect(screen.getByText('decisions.result.heading')).toBeInTheDocument();
    expect(screen.getByText('#1 跳槽')).toBeInTheDocument();
    expect(screen.getByText('#2 留下')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'decisions.feedback.submit' })).toBeInTheDocument();
  });

  it('模拟 429 → 限流提示', () => {
    simulateMock = { mutate: vi.fn(), isPending: false, error: new ApiError(429, 'rl') };
    render(<DecisionsPage />);
    fireEvent.click(screen.getByText('换工作还是留下'));
    expect(screen.getByText('decisions.errors.rateLimited')).toBeInTheDocument();
  });
});
