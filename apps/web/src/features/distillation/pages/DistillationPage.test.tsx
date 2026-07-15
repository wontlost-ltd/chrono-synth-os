/**
 * DistillationPage：人格蒸馏审批页。mock query hooks，验证候选渲染、approve、reject Modal + 原因、tab 切换、409 冲突提示。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DistillationPage from './DistillationPage';
import { ApiError } from '../../../api/client';
import type { DistillArtifact } from '../../../api/queries/distillation';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));
vi.mock('../../../api/queries/personaCore', () => ({
  usePersonaCoreList: () => ({ data: [{ id: 'p1', displayName: '数字人甲' }], isLoading: false }),
}));

const candidate: DistillArtifact = {
  id: 'a1', kind: 'value_shift', source: 'reflection', status: 'candidate',
  confidence: 0.82, payload: { note: 'shift toward curiosity' }, evidence: [{ type: 'memory', id: 'm1', score: 0.9 }],
  createdAt: 1_700_000_000_000, compiledAt: null,
};

let candidatesMock: { data?: unknown; isLoading: boolean; error?: unknown };
let artifactsMock: { data?: unknown; isLoading: boolean; error?: unknown };
let approveMock: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error?: unknown };
let rejectMock: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error?: unknown };

vi.mock('../../../api/queries/distillation', async () => {
  const actual = await vi.importActual<typeof import('../../../api/queries/distillation')>('../../../api/queries/distillation');
  return {
    ...actual,
    useDistillCandidates: () => candidatesMock,
    useDistillArtifacts: () => artifactsMock,
    useApproveArtifact: () => approveMock,
    useRejectArtifact: () => rejectMock,
  };
});

function renderPage() {
  return render(<MemoryRouter><DistillationPage /></MemoryRouter>);
}

describe('DistillationPage', () => {
  beforeEach(() => {
    candidatesMock = { data: { items: [candidate], total: 1 }, isLoading: false };
    artifactsMock = { data: { items: [], total: 0 }, isLoading: false };
    approveMock = { mutate: vi.fn(), isPending: false };
    rejectMock = { mutate: vi.fn(), isPending: false };
  });

  it('渲染待审批候选（kind + 置信度 + payload）', () => {
    renderPage();
    expect(screen.getByText('distillation.kind.value_shift')).toBeInTheDocument();
    expect(screen.getByText(/82%/)).toBeInTheDocument();
    expect(screen.getByText(/curiosity/)).toBeInTheDocument();
  });

  it('点批准 → approve.mutate(artifactId)', () => {
    const mutate = vi.fn();
    approveMock = { mutate, isPending: false };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'distillation.actions.approve' }));
    expect(mutate).toHaveBeenCalledWith('a1');
  });

  it('点拒绝 → 打开 Modal；填原因后提交 reject.mutate({artifactId, reason})', () => {
    const mutate = vi.fn();
    rejectMock = { mutate, isPending: false };
    renderPage();
    /* 候选行的拒绝按钮（打开 Modal）。 */
    fireEvent.click(screen.getAllByRole('button', { name: 'distillation.actions.reject' })[0]!);
    const textarea = screen.getByPlaceholderText('distillation.reject.reasonPlaceholder');
    fireEvent.change(textarea, { target: { value: '与现有价值观冲突' } });
    /* Modal 内的拒绝按钮（提交）。 */
    const rejectButtons = screen.getAllByRole('button', { name: 'distillation.actions.reject' });
    fireEvent.click(rejectButtons[rejectButtons.length - 1]!);
    expect(mutate).toHaveBeenCalledWith({ artifactId: 'a1', reason: '与现有价值观冲突' }, expect.any(Object));
  });

  it('切到历史 tab → 显示 artifacts 空态', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'distillation.tab.artifacts' }));
    expect(screen.getByText('distillation.artifacts.empty')).toBeInTheDocument();
  });

  it('approve 409 冲突 → 显示明确冲突文案', () => {
    approveMock = { mutate: vi.fn(), isPending: false, error: new ApiError(409, 'conflict') };
    renderPage();
    expect(screen.getByText('distillation.errors.conflict')).toBeInTheDocument();
  });

  it('候选为空 → 空态', () => {
    candidatesMock = { data: { items: [], total: 0 }, isLoading: false };
    renderPage();
    expect(screen.getByText('distillation.candidates.empty')).toBeInTheDocument();
  });
});
