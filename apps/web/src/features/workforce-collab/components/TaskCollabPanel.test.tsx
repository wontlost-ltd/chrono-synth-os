/**
 * TaskCollabPanel：per-task 升级/交接。mock collab hooks，验证升级列表渲染、发起升级 mutate、交接列表、提议交接 mutate、429/409 提示。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskCollabPanel } from './TaskCollabPanel';
import { ApiError } from '../../../api/client';
import type { OrgTask } from '../../../api/queries/workforce';
import type { OrgEscalation, OrgHandoff } from '../../../api/queries/workforce-collab';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

let escListMock: { data?: OrgEscalation[]; isLoading: boolean; error?: unknown };
let handoffListMock: { data?: OrgHandoff[]; isLoading: boolean; error?: unknown };
const raiseMock = { mutate: vi.fn(), isPending: false, error: null as unknown };
const proposeMock = { mutate: vi.fn(), isPending: false, error: null as unknown };
const noop = { mutate: vi.fn(), isPending: false, error: null as unknown };

vi.mock('../../../api/queries/workforce-collab', async () => {
  const actual = await vi.importActual<typeof import('../../../api/queries/workforce-collab')>('../../../api/queries/workforce-collab');
  return {
    ...actual,
    useEscalations: () => escListMock,
    useRaiseEscalation: () => raiseMock,
    useResolveEscalation: () => noop,
    useReescalate: () => noop,
    useCancelEscalation: () => noop,
    useHandoffs: () => handoffListMock,
    useProposeHandoff: () => proposeMock,
    useAcceptHandoff: () => noop,
    useRejectHandoff: () => noop,
    useCancelHandoff: () => noop,
  };
});

const task: OrgTask = {
  id: 'task-1', goalId: 'g1', assignedToWorkerId: 'w1', accountableWorkerId: 'w0',
  title: '写博客', taskType: 'content', status: 'delegated', riskLevel: 'low',
  allowsToolExecution: true, acceptanceCriteria: '达标', requiredCapabilities: [], resultSummary: null,
};
const names = new Map([['w1', '写手甲'], ['w2', '主管乙']]);

beforeEach(() => {
  escListMock = { data: [], isLoading: false };
  handoffListMock = { data: [], isLoading: false };
  raiseMock.mutate = vi.fn(); raiseMock.error = null;
  proposeMock.mutate = vi.fn(); proposeMock.error = null;
});

describe('TaskCollabPanel', () => {
  it('渲染升级链 + 交接两块（标题）', () => {
    render(<TaskCollabPanel orgId="org-1" task={task} workerNames={names} />);
    expect(screen.getByText('collab.escalations.heading')).toBeInTheDocument();
    expect(screen.getByText('collab.handoffs.heading')).toBeInTheDocument();
  });

  it('填发起者+原因 → 发起升级 mutate（含 taskId）', () => {
    render(<TaskCollabPanel orgId="org-1" task={task} workerNames={names} />);
    fireEvent.change(screen.getAllByPlaceholderText('collab.fromWorkerId')[0]!, { target: { value: 'w1' } });
    fireEvent.change(screen.getByPlaceholderText('collab.escalations.reasonPlaceholder'), { target: { value: '卡住了' } });
    fireEvent.click(screen.getByRole('button', { name: 'collab.escalations.raise' }));
    expect(raiseMock.mutate).toHaveBeenCalledTimes(1);
    const arg = raiseMock.mutate.mock.calls[0]![0];
    expect(arg).toMatchObject({ taskId: 'task-1', fromWorkerId: 'w1', reason: '卡住了' });
  });

  it('填交接双方 → 提议交接 mutate（含 toWorkerId）', () => {
    render(<TaskCollabPanel orgId="org-1" task={task} workerNames={names} />);
    const froms = screen.getAllByPlaceholderText('collab.fromWorkerId');
    fireEvent.change(froms[froms.length - 1]!, { target: { value: 'w1' } });
    fireEvent.change(screen.getByPlaceholderText('collab.toWorkerId'), { target: { value: 'w2' } });
    fireEvent.click(screen.getByRole('button', { name: 'collab.handoffs.propose' }));
    expect(proposeMock.mutate).toHaveBeenCalledTimes(1);
    expect(proposeMock.mutate.mock.calls[0]![0]).toMatchObject({ taskId: 'task-1', fromWorkerId: 'w1', toWorkerId: 'w2' });
  });

  it('待处理升级显示处置/再升级/取消按钮；已处置的不显示', () => {
    escListMock = {
      isLoading: false,
      data: [
        { id: 'e1', tenantId: 't', orgId: 'org-1', taskId: 'task-1', fromWorkerId: 'w1', toWorkerId: 'w2', parentEscalationId: null, depth: 0, status: 'pending', reason: '卡住', resolution: null, correlationId: null, createdAt: 1, decidedAt: null },
      ],
    };
    render(<TaskCollabPanel orgId="org-1" task={task} workerNames={names} />);
    expect(screen.getByText('写手甲 → 主管乙')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'collab.escalations.resolve' })).toBeInTheDocument();
  });

  it('升级 mutation 429 → 限流提示', () => {
    raiseMock.error = new ApiError(429, 'rl');
    render(<TaskCollabPanel orgId="org-1" task={task} workerNames={names} />);
    expect(screen.getByText('collab.errors.rateLimited')).toBeInTheDocument();
  });
});
