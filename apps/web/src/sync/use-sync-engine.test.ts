/**
 * useSyncEngine — 404 优雅降级回归。
 *
 * 增量同步端点（/api/v1/sync/pull|push）在当前后端不存在（只有形态不同的 v2）。
 * 命中 404 时引擎必须：①收敛到 'disabled' 干净态（非 'error'）②不再重试（停止 404 洪水）。
 * 这两点是「修次要发现①」的验收契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ApiError } from '@/api/client';

/* 模拟在线 + 固定 tenant。 */
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
vi.mock('@/store/session', () => ({ getSession: () => ({ tenantId: 'default' }) }));

const pullMock = vi.fn();
const flushMock = vi.fn();
const countMock = vi.fn();
vi.mock('./sync-client', () => ({
  pullIncremental: (...a: unknown[]) => pullMock(...a),
  flushOutbox: (...a: unknown[]) => flushMock(...a),
  countOutbox: (...a: unknown[]) => countMock(...a),
}));

import { useSyncEngine } from './use-sync-engine';

describe('useSyncEngine — 增量同步端点 404 降级', () => {
  beforeEach(() => {
    pullMock.mockReset();
    flushMock.mockReset();
    countMock.mockReset().mockResolvedValue(0);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('pull 命中 404 → 收敛到 disabled（而非 error），且不再继续 pull', async () => {
    pullMock.mockRejectedValue(new ApiError(404, 'Not Found'));
    const { result } = renderHook(() => useSyncEngine({ enabled: true, pollIntervalMs: 10 }));

    /* 挂载即触发一次 runSync → pull 抛 404 → disabled。 */
    await waitFor(() => expect(result.current.snapshot.state).toBe('disabled'));
    expect(result.current.snapshot.lastErrorCode).toBeNull(); // 不是 error 态，无 errorCode

    const callsAfterFirst = pullMock.mock.calls.length;
    /* 再等几个 poll 周期，404 短路后不应再调 pull。 */
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(pullMock.mock.calls.length).toBe(callsAfterFirst); // 没有新增 pull
  });

  it('非 404 错误仍按可重试的 error 处理（不被短路误吞）', async () => {
    pullMock.mockRejectedValue(new ApiError(500, 'Server Error'));
    const { result } = renderHook(() => useSyncEngine({ enabled: true, pollIntervalMs: 10 }));
    await waitFor(() => expect(result.current.snapshot.state).toBe('error'));
    expect(result.current.snapshot.lastErrorCode).toBe('SYNC_ERROR');
  });

  /* Codex 交叉审查发现①：pull 成功但 push（flushOutbox）抛 404 时，也必须降级 disabled
   * （此前 flushOutbox 吞掉 404 不上抛，push 404 到不了引擎 → sync 假成功）。 */
  it('pull 成功但 push 404 → 同样降级 disabled，停止后续轮询', async () => {
    pullMock.mockResolvedValue(0);
    countMock.mockResolvedValue(1); // 有待推送
    flushMock.mockRejectedValue(new ApiError(404, 'Not Found')); // push 端点不存在
    const { result } = renderHook(() => useSyncEngine({ enabled: true, pollIntervalMs: 10 }));
    await waitFor(() => expect(result.current.snapshot.state).toBe('disabled'));
    expect(result.current.snapshot.lastErrorCode).toBeNull();
    const calls = pullMock.mock.calls.length;
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(pullMock.mock.calls.length).toBe(calls); // 短路后不再轮询
  });

  /* Codex 交叉审查发现②：404 disabled 后，enabled prop 切走再切回 true，状态必须保持 disabled
   * （ref 永久短路了实际同步，UI 不能显示「已启用」而行为已禁用）。 */
  it('404 disabled 后 enabled toggle 回 true 仍保持 disabled（状态与行为一致）', async () => {
    pullMock.mockRejectedValue(new ApiError(404, 'Not Found'));
    const { result, rerender } = renderHook(
      ({ enabled }) => useSyncEngine({ enabled, pollIntervalMs: 10 }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.snapshot.state).toBe('disabled'));
    rerender({ enabled: false });
    rerender({ enabled: true }); // 重新启用
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(result.current.snapshot.state).toBe('disabled'); // 仍 disabled，不被配置回 enabled
  });
});
