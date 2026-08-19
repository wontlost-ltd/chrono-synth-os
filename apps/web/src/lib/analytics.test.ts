/**
 * Tests for the analytics shim.
 *
 * Focus: queue lifecycle, batching, flush-on-hide, error swallowing.
 * We don't test the wire format of the actual POST body beyond verifying
 * fetch/sendBeacon was called — the schema is informally pinned by
 * src/server/routes/analytics.ts (planned).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAnalyticsForTest, flush, initAnalytics, track } from './analytics';

/**
 * 等到 flush 真的发出请求为止 —— **不要**用 `setTimeout(30)` 猜时长。
 *
 * ⚠️ 旧写法 `await new Promise(r => setTimeout(r, 30))` 实测在安静机器上就有
 * 5/15 的失败率，且**两个方向都会错**：等太早 → 0 次调用；上个用例漏下来的
 * 排期在本用例触发 → 2 次调用。根因是 scheduleFlush 用 setTimeout(0)，与测试
 * 的 setTimeout(30) 同属定时器队列，繁忙时先后顺序没有保证；flush() 内部还有
 * 一次 `await import(...)` 和一次 await fetch，又多两个微任务跳。
 *
 * 改为轮询「fetch 被调用到期望次数」并让出事件循环，条件达成即返回。
 */
async function waitForFetchCalls(times: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  while (calls() < times) {
    if (Date.now() > deadline) {
      throw new Error(`等待 fetch 被调用 ${times} 次超时，实际 ${calls()} 次`);
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  /* 再让出一轮：若存在**多余**的第二次 flush（回归），它会在此刻现形，
   * 使 toHaveBeenCalledTimes 断言能抓到，而不是恰好在检查前没跑到。 */
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe('analytics shim', () => {
  beforeEach(() => {
    _resetAnalyticsForTest();
    /* fetch is the default transport; mock to capture batches */
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function lastFetchBody(): { events: Array<{ name: string; properties?: Record<string, unknown>; ts: number }> } {
    const mock = (fetch as unknown as ReturnType<typeof vi.fn>).mock;
    const lastCall = mock.calls[mock.calls.length - 1];
    if (!lastCall) throw new Error('expected fetch to have been called');
    const init = lastCall[1] as RequestInit | undefined;
    return JSON.parse((init?.body as string) ?? '{}');
  }

  it('queues a single event and flushes on the microtask boundary', async () => {
    track('test.event', { foo: 'bar' });
    await waitForFetchCalls(1);

    expect(fetch).toHaveBeenCalledTimes(1);
    const mock = (fetch as unknown as ReturnType<typeof vi.fn>).mock;
    const [url, init] = mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/analytics/events');
    expect(init?.method).toBe('POST');
    const body = lastFetchBody();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.name).toBe('test.event');
    expect(body.events[0]?.properties).toEqual({ foo: 'bar' });
    expect(typeof body.events[0]?.ts).toBe('number');
  });

  it('batches events fired in the same tick into one POST', async () => {
    track('a');
    track('b');
    track('c');
    await waitForFetchCalls(1);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchBody().events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });

  it('forces an immediate flush once the batch threshold is reached', async () => {
    /* BATCH_SIZE = 20 — fire 20 to hit the threshold, then 1 more */
    for (let i = 0; i < 20; i++) track(`event.${i}`);
    /* 第 20 次 track 会立即 flush；同时必须撤掉此前 setTimeout(0) 的排期，
     * 否则这里会看到 2 次 POST（曾经的真实缺陷）。 */
    await waitForFetchCalls(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchBody().events).toHaveLength(20);
  });

  it('swallows fetch failures so user flow is never broken', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    track('test.error.path');
    /* If the rejection escaped, this test would unhandled-reject and fail. */
    await expect(flush()).resolves.toBeUndefined();
  });

  it('flush() with empty queue is a no-op (no fetch)', async () => {
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('initAnalytics is idempotent — multiple calls do not double-bind handlers', () => {
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    initAnalytics();
    initAnalytics();
    initAnalytics();
    /* Only the first call should bind the visibilitychange listener */
    const visibilityCalls = addEventListenerSpy.mock.calls.filter((c) => c[0] === 'visibilitychange');
    expect(visibilityCalls).toHaveLength(1);
    addEventListenerSpy.mockRestore();
  });
});
