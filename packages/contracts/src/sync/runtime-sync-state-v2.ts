import { z } from 'zod';

export const RuntimeSyncStateV2Values = [
  'initial_sync',
  'online_synced',
  'online_dirty',
  'syncing',
  'offline_queueing',
  'offline_readonly',
  'conflict_inbox',
  'degraded_remote',
  'reauth_required',
  'recovery_required',
] as const;

export const RuntimeSyncStateV2Schema = z.enum(RuntimeSyncStateV2Values);
export type RuntimeSyncStateV2 = z.infer<typeof RuntimeSyncStateV2Schema>;

export const SyncStatusSnapshotV2Schema = z.object({
  schemaVersion: z.literal(2).default(2),
  state: RuntimeSyncStateV2Schema,
  tenantId: z.string().min(1),
  runtimeId: z.string().min(1),
  networkOnline: z.boolean(),
  authValid: z.boolean(),
  remoteReachable: z.boolean(),
  localWritable: z.boolean(),
  pendingPushCount: z.number().int().min(0).default(0),
  pendingPullCount: z.number().int().min(0).default(0),
  conflictCount: z.number().int().min(0).default(0),
  activeRunId: z.string().min(1).nullable().default(null),
  lastSyncedLedgerVersion: z.number().int().min(0).nullable().default(null),
  localHighWatermark: z.number().int().min(0).default(0),
  lastErrorCode: z.string().min(1).nullable().default(null),
}).strict();

export type SyncStatusSnapshotV2 = z.infer<typeof SyncStatusSnapshotV2Schema>;
