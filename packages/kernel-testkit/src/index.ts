/**
 * 同步状态快照测试夹具工厂
 * 用于 sync-engine 及上层集成测试
 */

import {
  SyncStatusSnapshotV1Schema,
  type RuntimeSyncStateV1,
  type SyncCapabilitiesV1,
  type SyncStatusSnapshotV1,
} from '@chrono/contracts';
import { createMemoryDatabase, runMigrations } from '../../../dist/index.js';
import type { IDatabase } from '../../../dist/index.js';

function buildCapabilities(
  state: RuntimeSyncStateV1,
  syncEnabled: boolean,
  networkOnline: boolean,
  conflictCount: number,
): SyncCapabilitiesV1 {
  return {
    canConfigure: state === 'unconfigured' || state === 'disabled',
    canStartSync: state === 'idle' && syncEnabled && networkOnline,
    canPause:
      (state === 'idle' || state === 'pulling' || state === 'merging' || state === 'pushing') &&
      syncEnabled,
    canResume: state === 'paused',
    canResolveConflict: state === 'conflicted' && conflictCount > 0,
    canRetry: state === 'error' && syncEnabled && networkOnline,
    canDisable: state !== 'unconfigured' && state !== 'disabled',
  };
}

export function createSyncStatusSnapshotFixture(
  overrides: Partial<SyncStatusSnapshotV1> = {},
): SyncStatusSnapshotV1 {
  const state = overrides.state ?? 'unconfigured';
  const syncEnabled = overrides.syncEnabled ?? false;
  const networkOnline = overrides.networkOnline ?? true;
  const conflictCount = overrides.conflictCount ?? 0;

  return SyncStatusSnapshotV1Schema.parse({
    schemaVersion: 1,
    state,
    syncEnabled,
    networkOnline,
    pendingPullCount: 0,
    pendingPushCount: 0,
    conflictCount,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    activeRunId: null,
    capabilities: buildCapabilities(state, syncEnabled, networkOnline, conflictCount),
    ...overrides,
  });
}

export function createMigratedMemoryDb(): IDatabase {
  const db = createMemoryDatabase();
  runMigrations(db);
  return db;
}

export function withMigratedDb<T>(fn: (db: IDatabase) => T): T {
  return fn(createMigratedMemoryDb());
}

export async function withMigratedDbAsync<T>(
  fn: (db: IDatabase) => Promise<T>,
): Promise<T> {
  return fn(createMigratedMemoryDb());
}
