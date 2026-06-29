/**
 * useSyncEngine — 离线优先同步状态机
 *
 * 驱动 RuntimeSyncStateV1 状态机，协调：
 * - 网络状态变化 → offline / resumed 事件
 * - 定时 pull + flush outbox
 * - 暴露 SyncStatusSnapshotV1 给 UI 消费
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { RuntimeSyncEvent, SyncStatusSnapshotV1 } from '@chrono/contracts';
import { deriveRuntimeSyncState } from '@chrono/sync-engine';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { getSession } from '@/store/session';
import { ApiError } from '@/api/client';
import { pullIncremental, flushOutbox, countOutbox } from './sync-client';

// ── State machine ─────────────────────────────────────────────────────────────

type SyncState = SyncStatusSnapshotV1;

function initialState(syncEnabled: boolean, networkOnline: boolean): SyncState {
  const base: SyncState = {
    schemaVersion: 1,
    state: 'unconfigured',
    syncEnabled: false,
    networkOnline,
    pendingPullCount: 0,
    pendingPushCount: 0,
    conflictCount: 0,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    activeRunId: null,
    capabilities: {
      canConfigure: true,
      canStartSync: false,
      canPause: false,
      canResume: false,
      canResolveConflict: false,
      canRetry: false,
      canDisable: false,
    },
  };

  return deriveRuntimeSyncState(base, {
    type: 'sync.configured',
    enabled: syncEnabled,
    occurredAt: Date.now(),
  });
}

const applyEvent = (prev: SyncState, event: RuntimeSyncEvent): SyncState =>
  deriveRuntimeSyncState(prev, event);

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseSyncEngineOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
}

export interface UseSyncEngineResult {
  snapshot: SyncStatusSnapshotV1;
  pause: () => void;
  resume: () => void;
  enable: () => void;
  disable: () => void;
  triggerSync: () => void;
}

export function useSyncEngine({
  enabled = false,
  pollIntervalMs = 30_000,
}: UseSyncEngineOptions = {}): UseSyncEngineResult {
  const networkOnline = useOnlineStatus();
  const [snapshot, dispatch] = useReducer(applyEvent, undefined, () =>
    initialState(enabled, networkOnline),
  );
  const syncingRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  /* 增量同步端点（/api/v1/sync/pull|push）在当前后端**不存在**（后端只实现了形态不同的
   * v2 flush-and-report，无 v1 cursor-based 增量协议）。一旦命中 404 即视为「此后端不提供
   * 增量同步」，置位此 ref：停止轮询、不再把 404 当可重试错误反复刷——否则 setInterval 每 30s
   * 永久 404 洪水 + sync 状态恒 error。待后端真正实现 v1 sync 协议时移除此短路。 */
  const syncUnavailableRef = useRef(false);

  // Network state changes
  useEffect(() => {
    dispatch(
      networkOnline
        ? { type: 'sync.network.online', occurredAt: Date.now() }
        : { type: 'sync.network.offline', occurredAt: Date.now() },
    );
  }, [networkOnline]);

  // Sync enabled/disabled changes
  useEffect(() => {
    /* 若本会话已探测到后端无增量同步端点（404→syncUnavailableRef），即使 enabled prop 切回 true 也
     * 保持 disabled——否则状态机会显示「已启用/idle」而 runSync 仍被 ref 永久短路，UI 与实际行为不一致
     * （Codex 交叉审查发现）。404 是「此后端不支持」的能力探测结论，仅页面重载（新 ref）才重新探测。 */
    if (enabled && syncUnavailableRef.current) {
      dispatch({ type: 'sync.disabled', occurredAt: Date.now() });
      return;
    }
    dispatch({ type: 'sync.configured', enabled, occurredAt: Date.now() });
  }, [enabled]);

  const runSync = useCallback(async () => {
    const current = snapshotRef.current;
    if (syncingRef.current) return;
    if (syncUnavailableRef.current) return; // 后端无增量同步端点 → 不再尝试
    if (!current.syncEnabled || !current.networkOnline) return;
    if (current.state !== 'idle' && current.state !== 'error') return;

    syncingRef.current = true;
    const runId = crypto.randomUUID();
    dispatch({ type: 'sync.started', runId, occurredAt: Date.now() });

    try {
      const { tenantId } = getSession();

      // Pull
      const pulledCount = await pullIncremental(tenantId);
      dispatch({ type: 'sync.pull.completed', pendingPullCount: pulledCount, occurredAt: Date.now() });

      // Merge (count outbox)
      const pushCount = await countOutbox(tenantId);
      dispatch({ type: 'sync.merge.completed', pendingPushCount: pushCount, occurredAt: Date.now() });

      // Push
      await flushOutbox(tenantId);
      dispatch({ type: 'sync.push.completed', occurredAt: Date.now() });
    } catch (err) {
      /* 404 = 后端没有这个增量同步端点（特性未实现）。这不是「同步失败可重试」，而是
       * 「此后端不支持增量同步」——置位短路 + 收敛到 disabled（干净态，非 error），避免每轮
       * 重试 404 洪水与永久 error 状态。其余错误仍按可重试的 sync.failed 处理。 */
      if (err instanceof ApiError && err.status === 404) {
        syncUnavailableRef.current = true;
        dispatch({ type: 'sync.disabled', occurredAt: Date.now() });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        dispatch({
          type: 'sync.failed',
          errorCode: 'SYNC_ERROR',
          errorMessage: message,
          occurredAt: Date.now(),
        });
      }
    } finally {
      syncingRef.current = false;
    }
  }, []);

  // Poll loop
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => { void runSync(); }, pollIntervalMs);
    // Trigger immediately on mount
    void runSync();
    return () => clearInterval(id);
  }, [enabled, pollIntervalMs, runSync]);

  const pause = useCallback(() => dispatch({ type: 'sync.paused', occurredAt: Date.now() }), []);
  const resume = useCallback(() => dispatch({ type: 'sync.resumed', occurredAt: Date.now() }), []);
  const enable = useCallback(() => dispatch({ type: 'sync.configured', enabled: true, occurredAt: Date.now() }), []);
  const disable = useCallback(() => dispatch({ type: 'sync.disabled', occurredAt: Date.now() }), []);
  const triggerSync = useCallback(() => { void runSync(); }, [runSync]);

  return { snapshot, pause, resume, enable, disable, triggerSync };
}
