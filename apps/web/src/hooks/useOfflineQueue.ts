/**
 * 离线队列 Hook — IndexedDB 持久化（替换原 localStorage 实现）
 *
 * 使用 replica-store 的 outbox 对象仓库，确保队列在 Service Worker 重启后仍存在。
 * 每个 QueuedAction 以 OutboxEntry 格式存储，entityRef 为 "offline-action/<id>"。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import {
  enqueueOutbox,
  dequeueOutbox,
  getOutboxByTenant,
  type OutboxEntry,
} from '../sync/replica-store';

export interface QueuedAction {
  id: string;
  label: string;
  timestamp: number;
}

const TENANT_ID = 'local';
const MAX_QUEUE_SIZE = 100;

function actionToOutboxEntry(action: QueuedAction): OutboxEntry {
  return {
    commandId: action.id,
    tenantId: TENANT_ID,
    entityRef: `offline-action/${action.id}`,
    envelope: { label: action.label, timestamp: action.timestamp },
    enqueuedAt: action.timestamp,
    attempts: 0,
  };
}

function outboxEntryToAction(entry: OutboxEntry): QueuedAction {
  const env = entry.envelope as { label?: string; timestamp?: number };
  return {
    id: entry.commandId,
    label: env.label ?? entry.commandId,
    timestamp: env.timestamp ?? entry.enqueuedAt,
  };
}

let cachedQueue: QueuedAction[] = [];
const listeners = new Set<() => void>();
let loaded = false;

function notify(): void {
  for (const cb of listeners) cb();
}

async function loadFromIdb(): Promise<void> {
  try {
    const entries = await getOutboxByTenant(TENANT_ID);
    cachedQueue = entries
      .filter((e) => e.entityRef.startsWith('offline-action/'))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map(outboxEntryToAction);
  } catch {
    cachedQueue = [];
  }
  loaded = true;
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!loaded) {
    void loadFromIdb();
  }
  return () => { listeners.delete(cb); };
}

function getSnapshot(): QueuedAction[] {
  return cachedQueue;
}

function getServerSnapshot(): QueuedAction[] {
  return [];
}

export async function enqueueOfflineAction(label: string): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const action: QueuedAction = { id, label, timestamp: Date.now() };

  if (cachedQueue.length >= MAX_QUEUE_SIZE) return id;

  cachedQueue = [...cachedQueue, action];
  notify();

  try {
    await enqueueOutbox(actionToOutboxEntry(action));
  } catch {
    cachedQueue = cachedQueue.filter((a) => a.id !== id);
    notify();
  }
  return id;
}

export async function dequeueOfflineAction(id: string): Promise<void> {
  cachedQueue = cachedQueue.filter((a) => a.id !== id);
  notify();
  try {
    await dequeueOutbox(id);
  } catch { /* best-effort */ }
}

export async function clearOfflineQueue(): Promise<void> {
  cachedQueue = [];
  notify();
  try {
    const all = await getOutboxByTenant(TENANT_ID);
    const offlineEntries = all.filter((e) => e.entityRef.startsWith('offline-action/'));
    await Promise.all(offlineEntries.map((e) => dequeueOutbox(e.commandId)));
  } catch { /* best-effort */ }
}

export function useOfflineQueue() {
  const actions = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const enqueue = useCallback((label: string) => enqueueOfflineAction(label), []);
  const dequeue = useCallback((id: string) => dequeueOfflineAction(id), []);
  const clear = useCallback(() => clearOfflineQueue(), []);

  return { actions, enqueue, dequeue, clear, count: actions.length };
}

export function useReconnectFlush(
  flushFn: (action: QueuedAction) => Promise<void>,
): void {
  const isOnline = useOnlineStatus();

  useEffect(() => {
    if (!isOnline) return;

    const snapshot = [...cachedQueue];
    for (const action of snapshot) {
      void flushFn(action).then(() => dequeueOfflineAction(action.id)).catch(() => {});
    }
  }, [isOnline, flushFn]);
}
