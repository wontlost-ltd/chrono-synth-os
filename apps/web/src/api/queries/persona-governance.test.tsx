import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGovernancePolicy } from './persona-governance';

/*
 * ⚠️ 审计 #414：PersonaGovernance 页面因**双重解包**永久打不开。
 *
 * 后端 `earning.ts:145` 返回**单键**信封 `{data:{override,effective,meta}}`；
 * `apiFetch`（client.ts:250-259）对单键信封**已经解包**；查询层却又
 * `.then(r => r.data)` 再解一次 → `undefined` → 页面 `!data` 守卫必定命中，
 * **永远**只显示 loadError。GET/PUT/DELETE 三个动词全中。
 *
 * ⚠️ 为什么既有测试没抓到：`PersonaGovernance.test.tsx` 用 `vi.mock` 把整个 query
 * 模块替换掉了，出问题的 `queryFn` **零覆盖**；后端集成测试断言的是 wire 形状。
 * 两侧都绿、缝隙无人测。
 *
 * ⚠️ 也不能只测 `apiFetch`：那样测的是通用解包，**查询文件里再解一次照样测不出**
 * （我第一版就是这么写的，变异后仍全绿）。必须**渲染真实 hook**，让
 * queryFn 这一层真的跑起来。
 */

const fetchMock = vi.fn();

const POLICY = {
  override: { dailySpendCapCents: 500 },
  effective: { dailySpendCapCents: 500 },
  meta: { updatedBy: 'u1', updatedAt: 1234 },
};

/** 后端真实响应形状：单键 data 信封。 */
function singleKeyEnvelope(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: body }),
    text: async () => JSON.stringify({ data: body }),
  } as unknown as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useGovernancePolicy（审计 #414 双重解包回归）', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('queryFn 返回解包后的策略对象（不得再解一次变 undefined）', async () => {
    fetchMock.mockResolvedValue(singleKeyEnvelope(POLICY));

    const { result } = renderHook(() => useGovernancePolicy('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    /* 变异实测：给 queryFn 补回 `.then(r => r.data)` → data 变 undefined，本断言转红。
     * 这正是页面 `!data` 守卫命中、永远显示 loadError 的那一刻。 */
    expect(result.current.data).toBeDefined();
    expect(result.current.data).toEqual(POLICY);
    expect(result.current.data?.effective).toBeDefined();
  });

  it('personaId 为空时不发请求（enabled 守卫）', () => {
    renderHook(() => useGovernancePolicy(''), { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
