import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* mock @tauri-apps/api/core 的 invoke，验 getSidecarEndpoint 的缓存语义（Codex S2 复审补：直接锁缓存实现，
 * 非仅经 http-client mock 间接证明）。 */
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { getSidecarEndpoint, __resetSidecarEndpointCache } from './sidecar-endpoint';

const TAURI = globalThis as { __TAURI_INTERNALS__?: unknown };

beforeEach(() => {
  __resetSidecarEndpointCache();
  invokeMock.mockReset();
  delete TAURI.__TAURI_INTERNALS__;
});
afterEach(() => {
  delete TAURI.__TAURI_INTERNALS__;
});

describe('getSidecarEndpoint 缓存语义（ADR-0061 S2）', () => {
  it('非 Tauri（无 __TAURI_INTERNALS__）→ 永久 null，不调 invoke，多次调用不重试', async () => {
    expect(await getSidecarEndpoint()).toBeNull();
    expect(await getSidecarEndpoint()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled(); /* 非 Tauri 根本不 invoke */
  });

  it('★Tauri 内 invoke 失败（sidecar 未就绪）= 瞬态，不缓存，下次重试★', async () => {
    TAURI.__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValueOnce(new Error('尚未就绪'));
    expect(await getSidecarEndpoint()).toBeNull();
    /* 第二次：sidecar 就绪返回端点——瞬态失败没缓存住 null，重试拿到。 */
    invokeMock.mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:51000', handshakeToken: 'hs', instanceNonce: 'n' });
    const ep = await getSidecarEndpoint();
    expect(ep?.baseUrl).toBe('http://127.0.0.1:51000');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('拿到端点 → 永久缓存，后续不再 invoke', async () => {
    TAURI.__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue({ baseUrl: 'http://127.0.0.1:52000', handshakeToken: 'hs', instanceNonce: 'n' });
    expect((await getSidecarEndpoint())?.baseUrl).toBe('http://127.0.0.1:52000');
    await getSidecarEndpoint();
    expect(invokeMock).toHaveBeenCalledTimes(1); /* 永久结论，只 invoke 一次 */
  });
});
