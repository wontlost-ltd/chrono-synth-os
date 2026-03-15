/**
 * 同步事件类型定义
 * 驱动 RuntimeSyncState 状态机转换的事件
 */

import { z } from 'zod';

const TimestampedSchema = z.object({
  occurredAt: z.number().int().nonnegative(),
}).strict();

const event = <T extends z.ZodRawShape>(shape: T) =>
  TimestampedSchema.extend(shape).strict();

export const RuntimeSyncEventSchema = z.discriminatedUnion('type', [
  event({
    type: z.literal('sync.configured'),
    enabled: z.boolean(),
  }),
  event({
    type: z.literal('sync.disabled'),
  }),
  event({
    type: z.literal('sync.started'),
    runId: z.string().min(1),
  }),
  event({
    type: z.literal('sync.pull.completed'),
    pendingPullCount: z.number().int().min(0).default(0),
  }),
  event({
    type: z.literal('sync.merge.completed'),
    pendingPushCount: z.number().int().min(0).default(0),
  }),
  event({
    type: z.literal('sync.push.completed'),
  }),
  event({
    type: z.literal('sync.conflict.detected'),
    conflictCount: z.number().int().min(1),
  }),
  event({
    type: z.literal('sync.conflict.resolved'),
  }),
  event({
    type: z.literal('sync.paused'),
  }),
  event({
    type: z.literal('sync.resumed'),
  }),
  event({
    type: z.literal('sync.network.offline'),
  }),
  event({
    type: z.literal('sync.network.online'),
  }),
  event({
    type: z.literal('sync.failed'),
    errorCode: z.string().min(1),
    errorMessage: z.string().optional(),
  }),
  event({
    type: z.literal('sync.reset'),
  }),
]);

export type RuntimeSyncEvent = z.infer<typeof RuntimeSyncEventSchema>;
