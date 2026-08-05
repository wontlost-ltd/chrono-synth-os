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

/* 任务状态可注入——原 mock 硬编码 data: undefined，导致 job.state 分支
 * 从未被执行，'queued'/'partial' 两个真实服务端状态的处理缺失长期无人发现。 */
let mockJobData: unknown = undefined;

vi.mock('../api/queries/portability', () => ({
  useStartExport: () => makeIdleMutation(mockStartExport),
  useExportJob: () => ({ data: mockJobData }),
  useDryRunImport: () => makeIdleMutation(mockDryRun),
  useCommitImport: () => makeIdleMutation(mockCommit),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockJobData = undefined;
});

/** 服务端 ExportJobStatusV1 的真实形状（契约 .strict()）。 */
function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'export-job-status.v1',
    exportId: 'exp_1',
    state: 'queued',
    percent: 0,
    createdAt: '2026-08-06T10:00:00.000Z',
    warnings: [],
    ...overrides,
  };
}

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

/* 审计 Warning B6-5：前端手写的 ExportJob 类型与服务端契约不符——
 * state 写成 'pending'（服务端是 'queued'）、漏掉 'partial'、
 * 把 errorCode 写成 errorMessage。后果：排队中/部分成功的任务落不进
 * 任何分支 → 界面停在 idle；失败原因永远读不到。 */
describe('useExportFlow — 服务端真实状态映射', () => {
  it("'queued'（服务端初始态）→ polling，而非停在 idle", async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp_1' });
    mockJobData = job({ state: 'queued' });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });
    expect(result.current.state.phase).toBe('polling');
  });

  it("'running' → polling", async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp_1' });
    mockJobData = job({ state: 'running', percent: 42 });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });
    expect(result.current.state.phase).toBe('polling');
  });

  it("'partial' → 独立相位，并暴露 warnings + 下载链接", async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp_1' });
    mockJobData = job({
      state: 'partial',
      percent: 100,
      downloadUrl: 'https://example.test/pack.json',
      warnings: [{ code: 'MEMORY_PARTIAL', messageId: 'export.warning.memoryPartial' }],
    });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });

    expect(result.current.state.phase).toBe('partial');
    expect(result.current.state.downloadUrl).toBe('https://example.test/pack.json');
    expect(result.current.state.warnings).toHaveLength(1);
    expect(result.current.state.warnings[0]?.code).toBe('MEMORY_PARTIAL');
  });

  it("'failed' → error，且 errorCode 真的被读出（契约字段非 errorMessage）", async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp_1' });
    mockJobData = job({ state: 'failed', errorCode: 'EXPORT_FAILED' });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });

    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.errorMessage).toBe('EXPORT_FAILED');
  });

  it("'completed' → ready", async () => {
    mockStartExport.mockResolvedValue({ exportId: 'exp_1' });
    mockJobData = job({ state: 'completed', percent: 100, downloadUrl: 'https://x.test/p.json' });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => { await result.current.start(); });
    expect(result.current.state.phase).toBe('ready');
  });
});
