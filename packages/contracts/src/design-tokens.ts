import type { RuntimeSyncStateV1 } from './sync/runtime-sync-state.js';

export const color = {
  status: {
    unconfigured: '#6B7280',
    disabled: '#6B7280',
    idle: '#2f6b3b',
    pulling: '#0369A1',
    merging: '#0369A1',
    pushing: '#0369A1',
    paused: '#6B7280',
    offline: '#6B7280',
    conflicted: '#C2410C',
    error: '#9f2621',
  } satisfies Record<RuntimeSyncStateV1, string>,
} as const;
