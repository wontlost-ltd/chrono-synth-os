/**
 * CompanionPerceiveScreen 行为回归（Codex #118 复审建议）：
 *   - 提交 → companionPerceive 收到 {modality:'audio', representation: 用户输入}；
 *   - 成功 → 按 ['companion', accountKey] 前缀 invalidate（让 Home/记忆/成长重取，且按账号隔离——
 *     这是 mobile 之前 Codex 隐私 Major 点的延续：感知写新记忆后不能串到别的账号缓存）。
 *
 * 用 @testing-library/react-native（与 companionCacheIsolation.test 同款 harness）。
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CompanionPerceiveScreen } from './CompanionPerceiveScreen';
import * as api from '../../companion/companionApi';

function wrap(qc: QueryClient, node: ReactNode) {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const OK_RESULT = {
  schemaVersion: 'companion-perceive-result.v1' as const,
  perceivedMemories: [{ id: 'mem_1', content: '我听到：今天开会很累', valence: -0.3, salience: 0.6 }],
  perceivedBy: 'teacher' as const,
  growthCandidateCount: 1,
  pendingApprovalCount: 1,
};

afterEach(() => jest.restoreAllMocks());

describe('CompanionPerceiveScreen', () => {
  it('提交 → companionPerceive 收到 {modality:audio, representation} → 渲染第一人称反馈', async () => {
    const spy = jest.spyOn(api, 'companionPerceive').mockResolvedValue(OK_RESULT as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { getByLabelText, getByText } = render(wrap(qc, <CompanionPerceiveScreen accountKey="userA:tenantA" />));

    fireEvent.changeText(getByLabelText('要让数字人感知的经历'), '今天开会很累。');
    fireEvent.press(getByText('让 TA 听'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ modality: 'audio', representation: '今天开会很累。' }));
    await waitFor(() => expect(getByText('我记住了')).toBeTruthy());
    expect(getByText('我听到：今天开会很累')).toBeTruthy();
    /* 待审批提示（ADR-0051 身份层 pending 红线在 UI 上可见）。 */
    expect(getByText(/有 1 处会等你确认/)).toBeTruthy();
  });

  it('成功后按 [companion, accountKey] 前缀 invalidate（账号隔离重取）', async () => {
    jest.spyOn(api, 'companionPerceive').mockResolvedValue(OK_RESULT as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { getByLabelText, getByText } = render(wrap(qc, <CompanionPerceiveScreen accountKey="userA:tenantA" />));

    fireEvent.changeText(getByLabelText('要让数字人感知的经历'), 'x');
    fireEvent.press(getByText('让 TA 听'));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['companion', 'userA:tenantA'] }),
    );
  });

  it('空白输入不触发请求（提交按钮 disabled）', () => {
    const spy = jest.spyOn(api, 'companionPerceive').mockResolvedValue(OK_RESULT as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { getByText } = render(wrap(qc, <CompanionPerceiveScreen accountKey="userA:tenantA" />));

    fireEvent.press(getByText('让 TA 听'));
    expect(spy).not.toHaveBeenCalled();
  });
});
