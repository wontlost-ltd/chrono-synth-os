/**
 * CompanionNudgesScreen 行为回归（ADR-0054 主动性 · mobile 3 端齐平）：
 *   - 渲染主动消息列表（body + kind 标签 + 未读计数）；
 *   - 标记已读 → markCompanionNudgeRead 收到 id → 按 ['companion', accountKey, 'nudges'] invalidate；
 *   - 空态。
 * 用 @testing-library/react-native（与 CompanionPerceiveScreen.test 同款 harness）。
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CompanionNudgesScreen } from './CompanionNudgesScreen';
import * as api from '../../companion/companionApi';

/* useFocusEffect 需 NavigationContainer——测试无导航树，mock 成「挂载即跑一次 effect」。 */
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React = require('react');
    React.useEffect(() => cb(), [cb]);
  },
}));

function wrap(qc: QueryClient, node: ReactNode) {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const LIST = {
  schemaVersion: 'companion-nudge-list.v1' as const,
  items: [
    { id: 'pmsg-1', kind: 'growth', body: '我好像又成长了一点。', status: 'unread', createdAt: 1_700_000_000_000, readAt: null },
    { id: 'pmsg-2', kind: 'memory', body: '我一直在回想那次徒步。', status: 'read', createdAt: 1_700_000_001_000, readAt: 1_700_000_002_000 },
  ],
};

afterEach(() => jest.restoreAllMocks());

describe('CompanionNudgesScreen', () => {
  it('渲染主动消息列表 + 未读计数 + kind 标签', async () => {
    jest.spyOn(api, 'fetchCompanionNudges').mockResolvedValue(LIST as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { getByText } = render(wrap(qc, <CompanionNudgesScreen accountKey="userA:tenantA" />));

    await waitFor(() => getByText('我好像又成长了一点。'));
    getByText('我一直在回想那次徒步。');
    getByText('有 1 条还没读');
    getByText('成长'); /* growth kind 标签 */
  });

  it('标记已读 → markCompanionNudgeRead 收到 id + 按账号 nudges queryKey invalidate', async () => {
    jest.spyOn(api, 'fetchCompanionNudges').mockResolvedValue(LIST as never);
    const readSpy = jest.spyOn(api, 'markCompanionNudgeRead').mockResolvedValue(undefined as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { getByText } = render(wrap(qc, <CompanionNudgesScreen accountKey="userA:tenantA" />));

    await waitFor(() => getByText('标记已读'));
    fireEvent.press(getByText('标记已读'));

    await waitFor(() => {
      expect(readSpy).toHaveBeenCalledWith('pmsg-1');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['companion', 'userA:tenantA', 'nudges'] });
    });
  });

  it('空态：无主动消息', async () => {
    jest.spyOn(api, 'fetchCompanionNudges').mockResolvedValue({ schemaVersion: 'companion-nudge-list.v1', items: [] } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { getByText } = render(wrap(qc, <CompanionNudgesScreen accountKey="userA:tenantA" />));

    await waitFor(() => getByText('还没有主动消息 💬'));
  });
});
