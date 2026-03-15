/**
 * 租户数据清单 — 数据平面的租户配置契约
 * 描述租户的存储拓扑、加密策略、同步参数与数据保留策略
 */

import { z } from 'zod';

const StorageConfigSchema = z.object({
  primary: z.string(),
  replica: z.string().optional(),
}).strict();

const KmsConfigSchema = z.object({
  provider: z.enum(['platform', 'aws_kms', 'gcp_kms', 'azure_kv', 'vault']),
  keyRef: z.string().optional(),
}).strict();

const SyncConfigSchema = z.object({
  maxOfflineQueueSize: z.number().int().nonnegative().default(1000),
  maxOfflineAgeMs: z.number().int().nonnegative().default(7 * 24 * 60 * 60 * 1000),
  flushOnReconnect: z.boolean().default(true),
}).strict();

const RetentionConfigSchema = z.object({
  defaultRetentionDays: z.number().int().positive().default(365),
  auditRetentionDays: z.number().int().positive().default(730),
}).strict();

export const TenantManifestV1Schema = z.object({
  schemaVersion: z.literal('tenant-manifest.v1'),
  tenantId: z.string().min(1),
  region: z.string().min(1),
  deploymentMode: z.enum(['platform_managed', 'shared_cluster', 'dedicated_db', 'self_hosted']),
  encryptionMode: z.enum(['platform_managed', 'tenant_dedicated']),
  storage: StorageConfigSchema,
  kms: KmsConfigSchema,
  sync: SyncConfigSchema,
  retention: RetentionConfigSchema,
}).strict().superRefine((value, ctx) => {
  if (value.encryptionMode === 'tenant_dedicated') {
    if (value.kms.provider === 'platform') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kms', 'provider'],
        message: 'tenant_dedicated 加密模式不能使用 platform 托管的 KMS',
      });
    }
    if (!value.kms.keyRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kms', 'keyRef'],
        message: 'tenant_dedicated 加密模式必须提供 kms.keyRef',
      });
    }
  }
});

export type TenantManifestV1 = z.infer<typeof TenantManifestV1Schema>;
