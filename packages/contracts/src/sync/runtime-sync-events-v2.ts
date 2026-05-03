import { z } from 'zod';

const TimestampedSchema = z.object({
  occurredAt: z.number().int().nonnegative(),
}).strict();

const event = <T extends z.ZodRawShape>(shape: T) =>
  TimestampedSchema.extend(shape).strict();

export const RuntimeSyncEventV2Schema = z.discriminatedUnion('type', [
  event({ type: z.literal('sync.bootstrap.required') }),
  event({ type: z.literal('sync.bootstrap.completed'), ledgerVersion: z.number().int().min(0) }),
  event({ type: z.literal('sync.local.changed'), pendingPushCount: z.number().int().min(0) }),
  event({ type: z.literal('sync.started'), runId: z.string().min(1) }),
  event({ type: z.literal('sync.completed'), ledgerVersion: z.number().int().min(0) }),
  event({ type: z.literal('sync.network.offline'), queueWrites: z.boolean() }),
  event({ type: z.literal('sync.network.online') }),
  event({ type: z.literal('sync.conflict.detected'), conflictCount: z.number().int().min(1) }),
  event({ type: z.literal('sync.conflict.resolved'), remainingBlockingCount: z.number().int().min(0) }),
  event({ type: z.literal('sync.auth.expired') }),
  event({ type: z.literal('sync.auth.restored') }),
  event({ type: z.literal('sync.remote.degraded'), errorCode: z.string().min(1) }),
  event({ type: z.literal('sync.recovery.required'), errorCode: z.string().min(1) }),
  event({ type: z.literal('sync.reset') }),
]);

export type RuntimeSyncEventV2 = z.infer<typeof RuntimeSyncEventV2Schema>;
