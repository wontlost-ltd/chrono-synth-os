import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { GithubSetupCallback } from './GithubSetupCallback';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const fetchMock = vi.fn();

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: { ok: true } }),
    text: async () => JSON.stringify({ data: { ok: true } }),
  } as unknown as Response;
}

/** 取本次请求里的 installation_id（断言「后端真的收到了哪个 id」）。 */
function submittedIds(): string[] {
  return fetchMock.mock.calls.map((c) => {
    const url = String(c[0]);
    return new URL(url, 'http://x').searchParams.get('installation_id') ?? '';
  });
}

describe('GithubSetupCallback（审计 #416）', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('提交当前 installation_id 并显示成功', async () => {
    render(
      <MemoryRouter initialEntries={['/gh?installation_id=111']}>
        <GithubSetupCallback />
      </MemoryRouter>,
    );
    await waitFor(() => expect(submittedIds()).toContain('111'));
  });

  /*
   * ⚠️ 审计 #416：`submitted` 是**布尔** ref，置 true 后永不重置。
   *
   * 但依赖列表 `[installationId, ...]` 表明设计意图是随新 installation 重跑 ——
   * 用户给 org A 装完紧接着装 org B（查询串变化、组件未 remount）时，
   * effect 重跑却撞守卫 return，**后端只收到 A**；而成功横幅用的是**新的**
   * installationId ⇒ 页面显示「installation #B 已绑定」，实际 org B 的仓库
   * **永远不同步，全程无任何报错**。守卫和渲染读的是两个不同的事实源。
   */
  it('换新 installation_id 后必须重新提交（不得只记第一个）', async () => {
    /* ⚠️ 必须**原地导航**、不能重挂载：
     *   - 改 MemoryRouter 的 initialEntries → 那是初始值，rerender 不重新导航；
     *   - 加 key 强制新树 → 组件重挂载，布尔 ref 也会被重置，**缺陷版同样会提交 222**
     *     （实测变异存活）。
     * 用 Routes + 一个能改 URL 的按钮，在**同一棵树**内导航才复现真实场景。 */
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate('/gh?installation_id=222')}>go</button>
          <Routes><Route path="/gh" element={<GithubSetupCallback />} /></Routes>
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/gh?installation_id=111']}>
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(() => expect(submittedIds()).toContain('111'));

    /* 同一棵树内换查询串 —— 组件不重挂载，effect 因 installationId 变化而重跑。 */
    await act(async () => { fireEvent.click(screen.getByText('go')); });

    /* 变异实测：改回布尔 ref（`if (submitted.current) return`）
     * → 222 永远不会被提交，本断言转红 —— 而页面却会显示 222 已绑定。 */
    await waitFor(() => expect(submittedIds()).toContain('222'));
  });

  it('缺少 installation_id → 显示错误且不发请求', async () => {
    render(
      <MemoryRouter initialEntries={['/gh']}>
        <GithubSetupCallback />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/githubSetup\.missingParam/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
