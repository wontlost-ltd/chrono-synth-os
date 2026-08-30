import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOnlineStatus } from './useOnlineStatus';
import type { OutboxEntry } from '../sync/replica-store';
import type { QueuedAction } from './useOfflineQueue';
import {
  useOfflineQueue,
  useReconnectFlush,
  enqueueOfflineAction,
  dequeueOfflineAction,
  clearOfflineQueue,
} from './useOfflineQueue';

const mockOutbox = new Map<string, OutboxEntry>();

vi.mock('../sync/replica-store', () => ({
  enqueueOutbox: vi.fn(async (entry: OutboxEntry) => { mockOutbox.set(entry.commandId, entry); }),
  dequeueOutbox: vi.fn(async (id: string) => { mockOutbox.delete(id); }),
  getOutboxByTenant: vi.fn(async () => [...mockOutbox.values()]),
}));

vi.mock('./useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

beforeEach(async () => {
  mockOutbox.clear();
  vi.clearAllMocks();
  await clearOfflineQueue();
});

describe('enqueueOfflineAction', () => {
  it('returns a unique id', async () => {
    const a = await enqueueOfflineAction('action-1');
    const b = await enqueueOfflineAction('action-2');
    expect(a).not.toBe(b);
  });

  it('persists to IndexedDB outbox', async () => {
    await enqueueOfflineAction('save-persona');
    expect(mockOutbox.size).toBe(1);
    const [entry] = [...mockOutbox.values()];
    expect((entry?.envelope as { label?: string })?.label).toBe('save-persona');
  });

  it('records label and timestamp', async () => {
    const before = Date.now();
    await enqueueOfflineAction('my-action');
    const after = Date.now();
    const [entry] = [...mockOutbox.values()];
    const env = entry?.envelope as { label?: string; timestamp?: number };
    expect(env?.label).toBe('my-action');
    expect(env?.timestamp).toBeGreaterThanOrEqual(before);
    expect(env?.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('dequeueOfflineAction', () => {
  it('removes the action by id', async () => {
    const id = await enqueueOfflineAction('remove-me');
    await dequeueOfflineAction(id);
    expect(mockOutbox.has(id)).toBe(false);
  });

  it('is a no-op for unknown ids', async () => {
    await enqueueOfflineAction('keep-me');
    await dequeueOfflineAction('nonexistent-id');
    expect(mockOutbox.size).toBe(1);
  });
});

describe('clearOfflineQueue', () => {
  it('empties the queue', async () => {
    await enqueueOfflineAction('a');
    await enqueueOfflineAction('b');
    await clearOfflineQueue();
    expect(mockOutbox.size).toBe(0);
  });
});

describe('useOfflineQueue hook', () => {
  it('returns empty queue initially', () => {
    const { result } = renderHook(() => useOfflineQueue());
    expect(result.current.actions).toHaveLength(0);
    expect(result.current.count).toBe(0);
  });

  it('enqueue via hook reflects in actions', async () => {
    const { result } = renderHook(() => useOfflineQueue());
    await act(async () => { await result.current.enqueue('hook-action'); });
    expect(result.current.count).toBe(1);
    expect(result.current.actions[0]?.label).toBe('hook-action');
  });

  it('dequeue via hook removes action', async () => {
    const { result } = renderHook(() => useOfflineQueue());
    let id!: string;
    await act(async () => { id = await result.current.enqueue('to-remove'); });
    await act(async () => { await result.current.dequeue(id); });
    expect(result.current.count).toBe(0);
  });

  it('clear via hook empties queue', async () => {
    const { result } = renderHook(() => useOfflineQueue());
    await act(async () => {
      await result.current.enqueue('x');
      await result.current.enqueue('y');
    });
    await act(async () => { await result.current.clear(); });
    expect(result.current.count).toBe(0);
  });

  it('caps queue at 100 items', async () => {
    const { result } = renderHook(() => useOfflineQueue());
    await act(async () => {
      for (let i = 0; i < 110; i++) await result.current.enqueue(`action-${i}`);
    });
    expect(result.current.count).toBe(100);
  });
});

describe('useReconnectFlush', () => {
  it('calls flushFn for each queued action when online and dequeues on success', async () => {
    await enqueueOfflineAction('flush-me');

    const flushFn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useReconnectFlush(flushFn));

    await waitFor(() => expect(flushFn).toHaveBeenCalledOnce());
  });

  it('leaves action in queue when flushFn rejects', async () => {
    const { result } = renderHook(() => useOfflineQueue());
    await act(async () => { await result.current.enqueue('fails'); });

    const flushFn = vi.fn().mockRejectedValue(new Error('network error'));
    renderHook(() => useReconnectFlush(flushFn));

    await waitFor(() => expect(flushFn).toHaveBeenCalled());
    expect(result.current.count).toBe(1);
  });

  /* ⚠️ 审计 #439：`flushFn` 曾直接进依赖数组，而调用方几乎必然传内联箭头，
   * 其引用每次 render 都变 → 每次父组件重渲染都重发一遍，对非幂等 mutation
   * 就是重复提交。
   *
   * ⚠️ 本用例有一个**必须保持**的前提：flush 要停在 pending。
   * 若让它立即 resolve，成功路径会 dequeue 清空队列，下次 effect 读到空快照，
   * **缺陷版与修复版都只发 1 次**——用例恒绿、什么也测不到。
   * （这正是本仓记录过的假绿模式，改动此用例时先想清楚再动。） */
  it('审计 #439：父组件重渲染不得重发——内联 flushFn 的引用变化不算新一轮', async () => {
    await enqueueOfflineAction('flush-once');

    /* 永不 settle：模拟「请求在途期间父组件重渲染」这一真实条件。 */
    const spy = vi.fn((_a: QueuedAction) => new Promise<void>(() => {}));
    const { rerender } = renderHook(() => useReconnectFlush((a) => spy(a)));

    rerender();
    rerender();
    rerender();

    /* 变异实测：把依赖数组改回 `[isOnline, flushFn]` → 此处收到 4 次。 */
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /* ⚠️ 上一条只覆盖了「引用变化」这一半。`isOnline` **真实翻转**
   * （掉线→重连→再掉线→再重连）时 effect 本来就该重跑，稳定引用拦不住它；
   * 而上一轮 flush 若仍在途，它成功后才 dequeue，队列里那条还在 → 会被再发。
   * 这一半由 inFlight 去重负责，必须单独立一条，否则退掉它照样全绿。
   *
   * 变异实测：删掉 inFlight 判据 → 此处收到 2 次。 */
  it('审计 #439：重连翻转时在途的 action 不得重复冲洗', async () => {
    const online = vi.mocked(useOnlineStatus);
    await enqueueOfflineAction('inflight');

    const spy = vi.fn((_a: QueuedAction) => new Promise<void>(() => {}));   // 永不 settle：保持在途
    const { rerender } = renderHook(() => useReconnectFlush((a) => spy(a)));
    expect(spy).toHaveBeenCalledTimes(1);

    /* 掉线 → 重连：effect 真正重跑一轮（isOnline 变了，不是引用变化）。 */
    online.mockReturnValue(false);
    rerender();
    online.mockReturnValue(true);
    rerender();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  /* ⚠️ 第三条覆盖 ref 稳定化**独有**的那部分。
   * inFlight 去重只在 flush **仍在途**时挡得住；一旦 flush 已 settle
   * （这里用 reject——失败的 action 按设计留在队列里等下次重试），
   * inFlight 已清空，此时引用变化就会**再发一次**。
   *
   * 变异实测：把依赖数组改回 `[isOnline, flushFn]` → 此处收到 2 次。
   * 这也是为什么两个机制都得留：它们挡的不是同一段窗口。 */
  it('审计 #439：flush 失败后重渲染不得重发（inFlight 已清空，靠稳定引用兜）', async () => {
    await enqueueOfflineAction('failed-then-rerender');

    const spy = vi.fn((_a: QueuedAction) => Promise.reject(new Error('network error')));
    const { rerender } = renderHook(() => useReconnectFlush((a) => spy(a)));

    /* 等 reject 走完 .catch/.finally，inFlight 清空。 */
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(spy).toHaveBeenCalledTimes(1);

    rerender();
    rerender();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  /* 对照：修复不能是「把功能关掉」——真正的新一轮（重新挂载）仍须冲洗。 */
  it('对照：重新挂载仍会冲洗队列（没把功能一起关掉）', async () => {
    await enqueueOfflineAction('flush-again');

    const spy = vi.fn((_a: QueuedAction) => new Promise<void>(() => {}));
    const first = renderHook(() => useReconnectFlush((a) => spy(a)));
    expect(spy).toHaveBeenCalledTimes(1);

    first.unmount();
    renderHook(() => useReconnectFlush((a) => spy(a)));

    /* 新实例有自己的 inFlight 集合，队列里那条仍在 → 应再冲一次。 */
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
