/**
 * 离线队列 Hook — IndexedDB 持久化（替换原 localStorage 实现）
 *
 * 使用 replica-store 的 outbox 对象仓库，确保队列在 Service Worker 重启后仍存在。
 * 每个 QueuedAction 以 OutboxEntry 格式存储，entityRef 为 "offline-action/<id>"。
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
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

  /* ⚠️ 审计 #439：`flushFn` 此前直接进依赖数组。调用方几乎必然传内联箭头
   * （`useReconnectFlush((a) => post(a))`），其引用**每次 render 都变**，
   * 于是每次父组件重渲染都重跑一遍 flush —— 对非幂等 mutation 就是重复提交。
   *
   * 实测（1 次挂载 + 3 次 rerender，flush 保持 pending）：
   *   内联箭头 → 4 次调用；稳定引用 → 1 次。唯一变量是引用稳定性。
   *
   * 用 ref 存最新实现、依赖数组只留 `isOnline`：既不因引用变化重跑，
   * 又总是调到最新的 flushFn（不会闭包捕获陈旧版本）。 */
  const flushRef = useRef(flushFn);
  useEffect(() => { flushRef.current = flushFn; });

  /* 正在冲洗中的 action id。
   *
   * ⚠️ 光稳定引用**不够**：`isOnline` 真实翻转（掉线→重连→再掉线→再重连）
   * 时 effect 会正常重跑，此时上一轮的 flush 可能仍在途——它成功后才
   * `dequeueOfflineAction`，所以队列里那条还在，会被**再发一次**。
   * 用 ref 而非 state：置位不该触发 render，且必须对同一 effect 周期内的
   * 后续读取立即可见。 */
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isOnline) return;

    const snapshot = [...cachedQueue];
    for (const action of snapshot) {
      if (inFlightRef.current.has(action.id)) continue;
      inFlightRef.current.add(action.id);
      void flushRef.current(action)
        .then(() => dequeueOfflineAction(action.id))
        .catch(() => { /* 失败留在队列里，下次重连再试 */ })
        .finally(() => { inFlightRef.current.delete(action.id); });
    }
  }, [isOnline]);
}
