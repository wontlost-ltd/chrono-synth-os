import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useKnowledgeSources,
  useKnowledgeSource,
  useCreateKnowledgeSource,
  useUpdateKnowledgeSource,
  useDeleteKnowledgeSource,
  useSyncKnowledgeSource,
} from './knowledgeSources';

const mockApiFetch = vi.fn();
/* ⚠️ 必须一并提供真实的 `unwrapList`：这些 hook 现在链式调用它来解开
 * 分页信封 {data,pagination}。整模块 mock 时若漏掉它，运行时会 undefined 报错，
 * 表现为 isSuccess 恒 false（而不是断言值不符），很容易误判成别的问题。 */
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { apiFetch: (...args: unknown[]) => mockApiFetch(...args), unwrapList: actual.unwrapList };
});

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('useKnowledgeSources', () => {
  it('fetches list（分页信封被解包 —— 修复前有数据也渲染空状态）', async () => {
    /* ⚠️ 审计 P3：服务端返回 {data,pagination}，apiFetch 只对**单键** {data}
     * 自动解包。此前 hook 直接把它当数组，导致 `rows.length` 为 undefined →
     * DataTable 判 `!rows.length` 为真 → **有数据也显示「暂无来源」**。
     * 故这里 mock **真实的信封形态**，断言 hook 返回的是解包后的数组。 */
    const data = [{ id: '1', name: 'RSS' }];
    mockApiFetch.mockResolvedValue({ data, pagination: { page: 1, pageSize: 20, total: 1 } });
    const { result } = renderHook(() => useKnowledgeSources(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(data);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/knowledge-sources', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

describe('useKnowledgeSource', () => {
  it('fetches by encoded id', async () => {
    mockApiFetch.mockResolvedValue({ id: 'ks/1' });
    const { result } = renderHook(() => useKnowledgeSource('ks/1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/knowledge-sources/${encodeURIComponent('ks/1')}`, expect.any(Object));
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useKnowledgeSource(''), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useCreateKnowledgeSource', () => {
  it('sends POST', async () => {
    const body = { type: 'llm' as const, name: 'LLM', config: { systemPrompt: 'hi' } };
    mockApiFetch.mockResolvedValue({ id: '2', ...body });
    const { result } = renderHook(() => useCreateKnowledgeSource(), { wrapper: createWrapper() });
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/knowledge-sources', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });
});

describe('useUpdateKnowledgeSource', () => {
  it('sends PUT with encoded id', async () => {
    mockApiFetch.mockResolvedValue({ id: 'ks1' });
    const { result } = renderHook(() => useUpdateKnowledgeSource('ks1'), { wrapper: createWrapper() });
    result.current.mutate({ name: 'Renamed' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/knowledge-sources/${encodeURIComponent('ks1')}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Renamed' }),
    });
  });
});

describe('useDeleteKnowledgeSource', () => {
  it('sends DELETE', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteKnowledgeSource(), { wrapper: createWrapper() });
    result.current.mutate('del-ks');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/knowledge-sources/${encodeURIComponent('del-ks')}`, { method: 'DELETE' });
  });
});

describe('useSyncKnowledgeSource', () => {
  it('sends POST to sync endpoint', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSyncKnowledgeSource('ks1'), { wrapper: createWrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/knowledge-sources/ks1/sync', { method: 'POST' });
  });
});
