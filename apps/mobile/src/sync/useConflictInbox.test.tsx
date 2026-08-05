/**
 * 冲突收件箱契约回归（审计 Warning B6-1）。
 *
 * 修复前移动端自定义了一套与服务端完全不同的形状，并请求了不存在的端点：
 *   - GET  /api/v1/conflicts/inbox?status=pending   （真实路径是 /api/v1/conflicts）
 *   - POST /api/v1/conflicts/:id/dismiss            （服务端根本没有该端点）
 *   - 解决请求体 {choice}                            （契约要求 {conflictId, ifMatch, action}）
 *   - 读取 id/objectType/detectedAt:number           （契约是 conflictId/entityType/detectedAt:string）
 * 结果是列表恒空、解决必失败，且**没有任何测试**能发现——因为 mock 用的是
 * 前端自己臆想的形状。故本测用**服务端真实响应形状**做 mock，并断言请求
 * 路径与请求体，任一侧漂移都会转红。
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { useConflictInbox, useResolveConflict } from './useConflictInbox';
import * as client from '../api/client';

/** 服务端 toInboxItem 的真实输出形状（conflict-inbox.v1 契约）。 */
const SERVER_ITEM = {
  schemaVersion: 'conflict-inbox.v1',
  conflictId: 'cf_1',
  conflictVersion: 'v7',
  tenantId: 'tenant_a',
  entityType: 'persona',
  entityId: 'persona_1',
  sourceRuntime: 'mobile',
  detectedAt: '2026-08-06T10:00:00.000Z',
  severity: 'blocking',
  localSummaryId: 'persona.summary',
  localSummaryParams: { displayName: 'Local' },
  serverSummaryId: 'persona.summary',
  serverSummaryParams: { displayName: 'Server' },
  suggestedActions: ['keep_local', 'keep_server'],
} as const;

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useConflictInbox — 契约对齐', () => {
  it('请求真实路径 /api/v1/conflicts 并解开分页信封', async () => {
    const spy = jest.spyOn(client, 'apiFetch').mockResolvedValue({
      data: [SERVER_ITEM],
      pagination: { total: 1, limit: 20, offset: 0 },
    } as never);

    const { result } = renderHook(() => useConflictInbox(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(spy).toHaveBeenCalledWith('/api/v1/conflicts');
    expect(result.current.data).toHaveLength(1);
    /* 契约字段必须真的可读——旧实现读 item.id/objectType 会全是 undefined。 */
    expect(result.current.data?.[0]?.conflictId).toBe('cf_1');
    expect(result.current.data?.[0]?.entityType).toBe('persona');
    expect(typeof result.current.data?.[0]?.detectedAt).toBe('string');
  });

  it('服务端形状漂移（缺契约必填字段）→ 边界立即报错，而非渲染 undefined', async () => {
    jest.spyOn(client, 'apiFetch').mockResolvedValue({
      data: [{ id: 'cf_1', objectType: 'persona', detectedAt: 123 }],
    } as never);

    const { result } = renderHook(() => useConflictInbox(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useResolveConflict — 请求体契约', () => {
  it('POST 到 /resolve 且请求体含 conflictId/ifMatch/action（非旧的 {choice}）', async () => {
    const spy = jest.spyOn(client, 'apiFetch').mockResolvedValue({
      /* 与服务端 conflicts.ts 的真实返回逐字段一致（.strict()，多写少写都会被拒）。 */
      data: {
        schemaVersion: 'conflict-resolve-result.v1',
        conflictId: 'cf_1',
        action: 'keep_local',
        resolvedAt: '2026-08-06T10:01:00.000Z',
        resultingSyncState: 'online_synced',
        remainingBlockingCount: 0,
      },
    } as never);

    const { result } = renderHook(() => useResolveConflict(), { wrapper });
    result.current.mutate({ conflictId: 'cf_1', ifMatch: 'v7', action: 'keep_local' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [path, init] = spy.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/api/v1/conflicts/cf_1/resolve');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ conflictId: 'cf_1', ifMatch: 'v7', action: 'keep_local' });
    expect(body).not.toHaveProperty('choice');
  });

  it('merge_manually 缺 mergePayload → 请求前即被契约拒绝（不发网络请求）', async () => {
    const spy = jest.spyOn(client, 'apiFetch').mockResolvedValue({} as never);

    const { result } = renderHook(() => useResolveConflict(), { wrapper });
    result.current.mutate({ conflictId: 'cf_1', ifMatch: 'v7', action: 'merge_manually' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(spy).not.toHaveBeenCalled();
  });
});
