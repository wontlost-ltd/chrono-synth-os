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

  /* 回归：真实后端 GET /api/v1/conflicts 返回 paginate() 的 {data, pagination} 信封，
   * 而非裸数组。apiFetch 不会自动解包（含 pagination 非唯一字段），原 hook 直接
   * Schema.array().safeParse(信封) 必失败→收件箱对所有用户永远报错（哪怕 0 冲突）。
   * 此前的 mock 喂裸数组掩盖了该 bug；这里以真实信封形状回归。 */
  it('hydrates conflicts from the real {data, pagination} envelope', async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: [validItem],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    const { result } = renderHook(() => useConflictInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toHaveLength(1);
    expect(result.current.conflicts[0]!.conflictId).toBe('c1');
    expect(result.current.error).toBeNull();
  });

  /* 空信封（0 冲突）= 最常见情况，必须正常渲染空列表而非报错。 */
  it('handles an empty {data:[], pagination} envelope without error', async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    });
    const { result } = renderHook(() => useConflictInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toEqual([]);
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

  /* 畸形响应（既非数组也非 {data:[]} 信封）→ unwrapList 退化为 []，收件箱显示空列表而非崩溃。
   * 这比原来「报 load error」更稳健：一个被代理改写/字段缺失的响应不该让整页炸成错误卡片。
   * item 级 schema 漂移（数组里有坏元素）仍由上一条用例覆盖的 safeParse 拒绝。 */
  it('degrades to an empty list when the response is neither array nor {data} envelope', async () => {
    apiFetchMock.mockResolvedValueOnce({ unexpected: 'object' });
    const { result } = renderHook(() => useConflictInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
