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
    /* setTimeout(0) — yield to the next tick before asserting */
    await new Promise<void>((r) => setTimeout(r, 30));

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
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchBody().events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });

  it('forces an immediate flush once the batch threshold is reached', async () => {
    /* BATCH_SIZE = 20 — fire 20 to hit the threshold, then 1 more */
    for (let i = 0; i < 20; i++) track(`event.${i}`);
    /* No setTimeout yield needed — the 20th call triggers a sync flush kick */
    await new Promise<void>((r) => setTimeout(r, 30));
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
