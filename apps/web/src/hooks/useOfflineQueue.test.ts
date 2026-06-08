import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { OutboxEntry } from '../sync/replica-store';
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
});
