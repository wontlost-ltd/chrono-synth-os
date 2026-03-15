/**
 * 冲突收件箱 DTO — 跨端冲突处理的数据契约
 * 支持 TOCTOU 防护（乐观并发控制通过 ifMatch/conflictVersion）
 */

import { z } from 'zod';

const ConflictActionSchema = z.enum([
  'keep_local',
  'keep_server',
  'duplicate',
  'merge_manually',
]);

const SummaryParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export const ConflictInboxItemV1Schema = z.object({
  schemaVersion: z.literal('conflict-inbox.v1'),
  conflictId: z.string().min(1),
  conflictVersion: z.string().min(1),
  tenantId: z.string().min(1),
  entityType: z.enum(['persona', 'memory', 'task', 'device', 'policy']),
  entityId: z.string().min(1),
  commandId: z.string().optional(),
  sourceRuntime: z.enum(['web', 'mobile', 'desktop', 'node']),
  detectedAt: z.string().datetime({ offset: true }),
  severity: z.enum(['blocking', 'warning']),
  localSummaryId: z.string().min(1),
  localSummaryParams: SummaryParamsSchema,
  serverSummaryId: z.string().min(1),
  serverSummaryParams: SummaryParamsSchema,
  suggestedActions: z.array(ConflictActionSchema).min(1),
}).strict();

export const ConflictResolveRequestV1Schema = z.object({
  conflictId: z.string().min(1),
  ifMatch: z.string().min(1),
  action: ConflictActionSchema,
  mergePayload: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'merge_manually' && value.mergePayload === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mergePayload'],
      message: 'merge_manually 操作必须提供 mergePayload',
    });
  }
  if (value.action !== 'merge_manually' && value.mergePayload !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mergePayload'],
      message: 'mergePayload 仅允许在 merge_manually 操作中使用',
    });
  }
});

export const ConflictResolveResultV1Schema = z.object({
  schemaVersion: z.literal('conflict-resolve-result.v1'),
  conflictId: z.string().min(1),
  action: ConflictActionSchema,
  resolvedAt: z.string().datetime({ offset: true }),
  resultingSyncState: z.enum(['online_synced', 'syncing', 'conflict_inbox']),
  remainingBlockingCount: z.number().int().nonnegative(),
}).strict();

export type ConflictInboxItemV1 = z.infer<typeof ConflictInboxItemV1Schema>;
export type ConflictResolveRequestV1 = z.infer<typeof ConflictResolveRequestV1Schema>;
export type ConflictResolveResultV1 = z.infer<typeof ConflictResolveResultV1Schema>;
