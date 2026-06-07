/**
 * useConflictInbox — GA §8 #1 边界 Zod 解析覆盖测试。
 * 重点：
 *   1) 合法 schema 透传到 state.conflicts。
 *   2) schema 不匹配（缺少字段 / 非法 enum）走 load 错误分支，conflicts 不被写入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useConflictInbox } from './useConflictInbox';

vi.mock('@/sync/use-sync-engine', () => ({
  useSyncEngine: () => ({ triggerSync: vi.fn() }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

const validItem = {
  schemaVersion: 'conflict-inbox.v1',
  conflictId: 'c1',
  conflictVersion: 'v1',
  tenantId: 't1',
  entityType: 'persona',
  entityId: 'p1',
  sourceRuntime: 'web',
  detectedAt: '2026-05-24T12:00:00+00:00',
  severity: 'blocking',
  localSummaryId: 'local.summary',
  localSummaryParams: {},
  serverSummaryId: 'server.summary',
  serverSummaryParams: {},
  suggestedActions: ['keep_local'],
};

describe('useConflictInbox runtime parse', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hydrates conflicts when the payload matches the schema', async () => {
    apiFetchMock.mockResolvedValueOnce([validItem]);
    const { result } = renderHook(() => useConflictInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toHaveLength(1);
    expect(result.current.conflicts[0]!.conflictId).toBe('c1');
    expect(result.current.error).toBeNull();
  });

  it('falls into load error when the payload violates the schema', async () => {
    /* 删掉 schemaVersion → Zod 应当报错，hook 不能让损坏数据进入 state。 */
    const broken = { ...validItem, schemaVersion: undefined };
    apiFetchMock.mockResolvedValueOnce([broken]);
    const { result } = renderHook(() => useConflictInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.scope).toBe('load');
    expect(result.current.error?.message).toMatch(/conflict inbox schema mismatch/);
  });

  it('falls into load error when the response is not an array', async () => {
    apiFetchMock.mockResolvedValueOnce({ unexpected: 'object' });
    const { result } = renderHook(() => useConflictInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toEqual([]);
    expect(result.current.error?.scope).toBe('load');
  });
});
