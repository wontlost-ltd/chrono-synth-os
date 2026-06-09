/**
 * 隐私回归（ADR-0046 Phase 2.3，Codex 复审 Major）：companion 屏的 React Query key 必须含 accountKey，
 * 这样换账号时 B 的查询 key（含 accountKey_B）永不命中 A 的缓存（accountKey_A）——按构造隔离，无时序窗口。
 *
 * 直接断言渲染后 query cache 里的 key 形状，比端到端「看不到上一账号数据」更精确、更稳。
 */

import { render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CompanionHomeScreen } from './CompanionHomeScreen';
import { CompanionGrowthScreen } from './CompanionGrowthScreen';
import { CompanionMemoriesScreen } from './CompanionMemoriesScreen';
import * as api from '../../companion/companionApi';

function wrap(qc: QueryClient, node: ReactNode) {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** 收集 query cache 里所有 key（数组形式）。 */
function allKeys(qc: QueryClient): readonly unknown[][] {
  return qc.getQueryCache().getAll().map((q) => q.queryKey as unknown[]);
}

/* 用永不 resolve 的 fetch：query 停在 pending，渲染后不再有异步 state 更新——既不触发 act 警告，
 * 也不留开放定时器。本测试只关心 queryKey 形状（渲染即写入 cache），不需要数据真的回来。 */
beforeEach(() => {
  const pending = () => new Promise<never>(() => {});
  jest.spyOn(api, 'fetchCompanionMe').mockImplementation(pending as never);
  jest.spyOn(api, 'fetchCompanionGrowth').mockImplementation(pending as never);
  jest.spyOn(api, 'fetchCompanionMemories').mockImplementation(pending as never);
});

afterEach(() => jest.restoreAllMocks());

describe('companion 屏 queryKey 含 accountKey（跨账号缓存隔离）', () => {
  it('Home/Growth/Memories 的 key 第二段都是传入的 accountKey', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <CompanionHomeScreen accountKey="userA:tenantA" />));
    render(wrap(qc, <CompanionGrowthScreen accountKey="userA:tenantA" />));
    render(wrap(qc, <CompanionMemoriesScreen accountKey="userA:tenantA" />));

    const keys = allKeys(qc);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['companion', 'userA:tenantA', 'me'],
        ['companion', 'userA:tenantA', 'growth'],
        ['companion', 'userA:tenantA', 'memories'],
      ]),
    );
  });

  it('不同 accountKey → 不同 query key（B 不会命中 A 的缓存）', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <CompanionHomeScreen accountKey="userA:tenantA" />));
    render(wrap(qc, <CompanionHomeScreen accountKey="userB:tenantB" />));

    const meKeys = allKeys(qc).filter((k) => k[0] === 'companion' && k[2] === 'me');
    /* 两个不同账号 → 两条独立的 me 缓存项，互不复用。 */
    expect(meKeys).toEqual(
      expect.arrayContaining([
        ['companion', 'userA:tenantA', 'me'],
        ['companion', 'userB:tenantB', 'me'],
      ]),
    );
    expect(meKeys.length).toBe(2);
  });
});
