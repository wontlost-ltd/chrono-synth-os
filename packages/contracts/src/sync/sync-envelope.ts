/**
 * SyncEnvelopeV1 — 跨运行时同步命令信封
 * 每个离线排队或在线发送的写命令都包裹在此信封中
 * 支持签名验证、幂等性保证和 nonce 重放保护
 */

import { z } from 'zod';

export const SyncEnvelopeV1Schema = z.object({
  schemaVersion: z.literal('sync-envelope.v1'),
  commandId: z.string().min(1),
  tenantId: z.string().min(1),
  actorId: z.string().min(1),
  runtimeId: z.string().min(1),
  entityRef: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: z.string().min(8).regex(/^\S+$/, 'nonce 不能包含空白字符'),
  idempotencyKey: z.string().min(8).regex(/^\S+$/, 'idempotencyKey 不能包含空白字符'),
  payloadHash: z.string().min(8).regex(/^[a-zA-Z0-9:_\-+/=]+$/, 'payloadHash 必须为有效的编码字符串'),
  signatureKeyId: z.string().min(1).regex(/^\S+$/, 'signatureKeyId 不能包含空白字符'),
  signature: z.string().min(8).regex(/^[a-zA-Z0-9+/=\-_]+$/, 'signature 必须为有效的 base64/hex 编码'),
  signatureAlgorithm: z.enum(['hmac-sha256', 'ed25519']),
}).strict().superRefine((value, ctx) => {
  const created = new Date(value.createdAt).getTime();
  const expires = new Date(value.expiresAt).getTime();
  if (!Number.isNaN(created) && !Number.isNaN(expires) && expires <= created) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'expiresAt 必须晚于 createdAt',
    });
  }
});

export type SyncEnvelopeV1 = z.infer<typeof SyncEnvelopeV1Schema>;
