import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExportFlow, useImportFlow } from './usePortability';

// ── API mutation mocks ────────────────────────────────────────────────────────

const mockStartExport = vi.fn();
const mockDryRun = vi.fn();
const mockCommit = vi.fn();

const makeIdleMutation = (mutateAsync: ReturnType<typeof vi.fn>) => ({
  mutateAsync,
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
});

vi.mock('../api/queries/portability', () => ({
  useStartExport: () => makeIdleMutation(mockStartExport),
  useExportJob: () => ({ data: undefined }),
  useDryRunImport: () => makeIdleMutation(mockDryRun),
  useCommitImport: () => makeIdleMutation(mockCommit),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── useExportFlow ─────────────────────────────────────────────────────────────

describe('useExportFlow', () => {
  it('starts in idle phase', () => {
    const { result } = renderHook(() => useExportFlow());
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.exportId).toBeNull();
    expect(result.current.state.downloadUrl).toBeNull();
  });

  it('sets exportId after start resolves', async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp-123' });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });
    expect(result.current.state.exportId).toBe('exp-123');
  });

  it('reset clears exportId', async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp-456' });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });
    act(() => { result.current.reset(); });
    expect(result.current.state.exportId).toBeNull();
  });
});

// ── useImportFlow ─────────────────────────────────────────────────────────────

describe('useImportFlow', () => {
  const validReport = {
    valid: true,
    entityCount: 42,
    conflicts: [],
    warnings: [],
  };

  it('starts in idle phase', () => {
    const { result } = renderHook(() => useImportFlow());
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.report).toBeNull();
  });

  it('validate transitions to review on success', async () => {
    mockDryRun.mockResolvedValue(validReport);
    const { result } = renderHook(() => useImportFlow());
    await act(async () => { await result.current.validate('{"version":1}'); });
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.report?.entityCount).toBe(42);
  });

  it('validate transitions to error on failure', async () => {
    mockDryRun.mockRejectedValue(new Error('Bad pack'));
    const { result } = renderHook(() => useImportFlow());
    await act(async () => { await result.current.validate('bad'); });
    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.errorMessage).toBe('Bad pack');
  });

  it('confirmCommit transitions to done on success', async () => {
    mockDryRun.mockResolvedValue(validReport);
    mockCommit.mockResolvedValue({ importId: 'imp-1', importedCount: 40, skippedCount: 2 });
    const { result } = renderHook(() => useImportFlow());
    await act(async () => { await result.current.validate('{}'); });
    await act(async () => { await result.current.confirmCommit('tok-abc'); });
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.result?.importedCount).toBe(40);
    expect(mockCommit).toHaveBeenCalledWith({ manifestJson: '{}', importToken: 'tok-abc' });
  });

  it('confirmCommit transitions to error on failure', async () => {
    mockDryRun.mockResolvedValue(validReport);
    mockCommit.mockRejectedValue(new Error('Token expired'));
    const { result } = renderHook(() => useImportFlow());
    await act(async () => { await result.current.validate('{}'); });
    await act(async () => { await result.current.confirmCommit('bad-tok'); });
    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.errorMessage).toBe('Token expired');
  });

  it('reset returns to idle', async () => {
    mockDryRun.mockResolvedValue(validReport);
    const { result } = renderHook(() => useImportFlow());
    await act(async () => { await result.current.validate('{}'); });
    act(() => { result.current.reset(); });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.report).toBeNull();
  });

  it('confirmCommit is no-op when called before validate', async () => {
    const { result } = renderHook(() => useImportFlow());
    await act(async () => { await result.current.confirmCommit('tok'); });
    expect(mockCommit).not.toHaveBeenCalled();
  });
});
