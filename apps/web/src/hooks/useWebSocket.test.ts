import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts ?? {})}` }),
}));

/**
 * 可控的假 WebSocket：记录每次构造，允许测试显式触发 open/close。
 * 不用真实网络 —— 我们测的是重连**预算**的账，不是传输。
 */
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
  /** 模拟「连不上」：直接 close，不 open。 */
  failToConnect(): void { this.onclose?.(); }
}

describe('useWebSocket 重连预算（审计 #415）', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /*
   * ⚠️ 缺陷：cleanup 用 `attemptsRef.current = maxReconnectAttempts` 表达
   * 「别再重连了」，但该值**跨 effect 重跑存活**（useRef 不随 effect 重置），
   * 而 attemptsRef 只在 `ws.onopen` 归零。于是 effect 重跑后若首次连接没能 open，
   * onclose 看到 `attempts >= max` ⇒ **0 次重试**直接放弃。
   *
   * 生产触发点 `Dashboard.tsx:41`：`autoConnect: !!simId`，simId 随用户
   * 选择/取消模拟切换 —— 从模拟面板回总览再打开，恰逢后端短暂重启，
   * 就会立刻「重连失败(10)」（实际只试了 1 次），此后必须整页刷新。
   */
  /* ⚠️ 审计 #415 的**覆盖缺口，如实标注**：
   *
   * 缺陷是「cleanup 把 attemptsRef 烧成 max，而该值跨 effect 重跑存活」——
   * 需要「effect 重跑但组件**不重挂载**」才能复现。但在 testing-library 里
   * `rerender` 配合 StrictMode 双跑，每次都会走完整的 unmount→mount，
   * 新挂载自带的重置把陈旧预算掩盖掉：**修复版与缺陷版的实例数完全相同
   * （实测均为 4 → 6）**。
   *
   * 也就是说：我写不出能在此 harness 下转红的用例 —— 变异实测两版行为一致。
   * 与其留一条「看起来在测、其实测不到」的假绿用例，不如把这一点写清楚：
   *   - 修复本身是正确的（disposedRef 表达「已拆卸」，预算在挂载时归还），
   *     且**不改变**任何既有可观测行为（下面两条用例锁住正向语义）；
   *   - 真正的复现需要 E2E（真实浏览器 + 真实 WS 断连），本仓 CI 无此夹具。
   *
   * 下面两条锁住的是**不得回退**的正向语义：连接失败仍会重连、
   * 主动 disconnect 后不再重连。 */
  it('连接失败后必须安排重连（重试链未被 disposed 误杀）', () => {
    renderHook(() => useWebSocket({ url: 'ws://x', autoConnect: true, maxReconnectAttempts: 3 }));
    const before = FakeWS.instances.length;
    expect(before).toBeGreaterThanOrEqual(1);

    act(() => { FakeWS.instances[before - 1]!.failToConnect(); });
    act(() => { vi.advanceTimersByTime(30_000); });

    /* 变异实测：把 onclose 的 `!disposedRef.current` 改成 `disposedRef.current`
     * → 永不重连，本断言转红。 */
    expect(FakeWS.instances.length).toBeGreaterThan(before);
  });

  /* ⚠️ 如实标注：主动 disconnect() 的「不再重连」语义**在本 harness 下无法验证**。
   *
   * 试过两版判据（时钟推进后无新实例 / onclose 不再排期），变异（去掉
   * `disposedRef.current = true`）**两版都存活** —— 因为 disconnect 里的
   * `clearTimeout` 已经把已排期的重连清掉，而 FakeWS.close() 触发的 onclose
   * 走到重连分支时，排出的 timer 又会被下一次断言前的 clearTimeout 覆盖。
   * 要真正区分需要控制 timer 排期的内部状态，那已超出 hook 的公开面。
   *
   * 故此处不留假绿用例。disposedRef 的正向价值由上面那条
   * 「连接失败后必须安排重连」反向保证（它变异可转红）：
   * 若 disposed 判据写反，重连会被误杀，那条立刻红。 */
});
