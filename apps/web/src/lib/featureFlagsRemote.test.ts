/**
 * Step 10 — Remote feature-flag provider tests.
 *
 * We mock fetch + EventSource to avoid hitting the real network in
 * vitest. The provider's responsibilities under test:
 *
 *   1. Bootstrap fetch applies remote values to the local registry.
 *   2. SSE 'snapshot' overwrites bootstrap values (stream is fresher).
 *   3. SSE 'change' updates one flag without touching others.
 *   4. SSE 'error' transitions status to 'stale' but keeps values.
 *   5. localStorage override wins over remote (precedence regression).
 *   6. Teardown closes EventSource + aborts fetch.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  _resetFeatureFlagsForTest,
  getFlagValue,
  getFlagSource,
  getRemoteStatus,
} from './featureFlags';
import { bootstrapFeatureFlagsRemote, reconnectFeatureFlagsIfNotLive } from './featureFlagsRemote';

/* ── Mock EventSource ───────────────────────────────────────────── */

interface EventListenerSpy {
  type: string;
  fn: (ev: MessageEvent) => void;
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners: EventListenerSpy[] = [];

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    this.listeners.push({ type, fn });
  }

  removeEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    this.listeners = this.listeners.filter(l => l.type !== type || l.fn !== fn);
  }

  close(): void {
    this.closed = true;
  }

  /* Test helper — fire a synthetic event into the source. */
  _fire(type: string, data?: unknown): void {
    const ev = { data: data == null ? '' : JSON.stringify(data) } as MessageEvent;
    for (const l of this.listeners) {
      if (l.type === type) l.fn(ev);
    }
  }
}

beforeEach(() => {
  window.localStorage.clear();
  _resetFeatureFlagsForTest();
  MockEventSource.instances = [];
  /* @ts-expect-error — overriding the global EventSource for tests. */
  globalThis.EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown, status = 200): void {
  /* vitest's vi.spyOn doesn't replace globalThis.fetch reliably across
   * test isolation modes; assignment is the simplest path. */
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('featureFlagsRemote — bootstrap', () => {
  it('applies bootstrap values to the registry', async () => {
    mockFetchOnce({
      flags: [
        { flag: 'experimental.values_health_dashboard', value: true, source: 'remote' },
      ],
    });

    bootstrapFeatureFlagsRemote();
    /* Let the bootstrap promise resolve. */
    await new Promise(r => setTimeout(r, 0));

    expect(getFlagValue('experimental.values_health_dashboard', false)).toBe(true);
    expect(getFlagSource('experimental.values_health_dashboard')).toBe('remote');
  });

  it('does not throw when bootstrap returns 401 (pre-auth)', async () => {
    mockFetchOnce({}, 401);
    expect(() => bootstrapFeatureFlagsRemote()).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    /* Default still wins; nothing remote was applied. */
    expect(getFlagSource('experimental.values_health_dashboard')).toBe('static');
  });
});

/* 认证后重连：修「启动时 pre-auth 401 后 flags 整会话停在默认值」。 */
describe('featureFlagsRemote — reconnectFeatureFlagsIfNotLive', () => {
  it('状态非 live 时重连（开新 EventSource），让带 auth 的请求生效', async () => {
    /* 模拟启动 pre-auth 401：bootstrap + 一条 stream（未 open→非 live）。 */
    mockFetchOnce({}, 401);
    bootstrapFeatureFlagsRemote();
    await new Promise(r => setTimeout(r, 0));
    const beforeCount = MockEventSource.instances.length;
    expect(getRemoteStatus()).not.toBe('live');

    /* 认证后重连 → 应再开一条 stream。 */
    mockFetchOnce({ flags: [] });
    reconnectFeatureFlagsIfNotLive();
    expect(MockEventSource.instances.length).toBe(beforeCount + 1);
  });

  it('状态已 live 时不重连（幂等，避免重复连）', () => {
    mockFetchOnce({ flags: [] });
    bootstrapFeatureFlagsRemote();
    const es = MockEventSource.instances[0]!;
    es._fire('open'); // 触发 'live'
    expect(getRemoteStatus()).toBe('live');
    const liveCount = MockEventSource.instances.length;

    reconnectFeatureFlagsIfNotLive(); // 已 live → no-op
    expect(MockEventSource.instances.length).toBe(liveCount);
  });
});

describe('featureFlagsRemote — SSE stream', () => {
  it("'snapshot' event updates values + flips status to 'live' on open", () => {
    mockFetchOnce({ flags: [] });
    bootstrapFeatureFlagsRemote();

    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();
    expect(getRemoteStatus()).toBe('connecting');

    es!._fire('open');
    expect(getRemoteStatus()).toBe('live');

    es!._fire('snapshot', {
      flags: [
        { flag: 'cmdk.enabled', value: false, source: 'remote' },
      ],
    });
    expect(getFlagValue('cmdk.enabled', true)).toBe(false);
    expect(getFlagSource('cmdk.enabled')).toBe('remote');
  });

  it("'change' event updates a single flag in place", () => {
    mockFetchOnce({ flags: [] });
    bootstrapFeatureFlagsRemote();
    const es = MockEventSource.instances[0];

    es!._fire('open');
    /* Other flags retain their defaults — change is targeted. */
    expect(getFlagValue('changelog.drawer.enabled', false)).toBe(true);
    es!._fire('change', { flag: 'cmdk.enabled', value: false });

    expect(getFlagValue('cmdk.enabled', true)).toBe(false);
    expect(getFlagValue('changelog.drawer.enabled', false)).toBe(true);
  });

  it("'error' transitions status to 'stale' but keeps values", () => {
    mockFetchOnce({ flags: [] });
    bootstrapFeatureFlagsRemote();
    const es = MockEventSource.instances[0];

    es!._fire('open');
    es!._fire('change', { flag: 'cmdk.enabled', value: false });
    expect(getFlagValue('cmdk.enabled', true)).toBe(false);

    es!._fire('error');
    expect(getRemoteStatus()).toBe('stale');
    /* Critical: a network blip must NOT revert flag values. */
    expect(getFlagValue('cmdk.enabled', true)).toBe(false);
  });
});

describe('featureFlagsRemote — precedence', () => {
  it('localStorage override beats incoming remote change', async () => {
    window.localStorage.setItem('chrono.flag.cmdk.enabled', 'true');
    /* Re-read overrides before the provider runs; the provider does
     * not refresh storage on its own (separate concern). */
    _resetFeatureFlagsForTest();

    mockFetchOnce({
      flags: [{ flag: 'cmdk.enabled', value: false, source: 'remote' }],
    });
    bootstrapFeatureFlagsRemote();
    await new Promise(r => setTimeout(r, 0));

    expect(getFlagValue('cmdk.enabled', false)).toBe(true);
    expect(getFlagSource('cmdk.enabled')).toBe('override');
  });
});

describe('featureFlagsRemote — teardown', () => {
  it('teardown closes the EventSource', async () => {
    mockFetchOnce({ flags: [] });
    const stop = bootstrapFeatureFlagsRemote();
    const es = MockEventSource.instances[0];
    expect(es?.closed).toBe(false);

    stop();
    expect(es?.closed).toBe(true);
    expect(getRemoteStatus()).toBe('idle');
  });

  it('calling bootstrap twice closes the previous stream (HMR safety)', () => {
    mockFetchOnce({ flags: [] });
    bootstrapFeatureFlagsRemote();
    const first = MockEventSource.instances[0];

    mockFetchOnce({ flags: [] });
    bootstrapFeatureFlagsRemote();
    const second = MockEventSource.instances[1];

    expect(first?.closed).toBe(true);
    expect(second?.closed).toBe(false);
  });
});
