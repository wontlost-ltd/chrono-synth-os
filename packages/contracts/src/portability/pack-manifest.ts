/**
 * 可移植性包清单 — 跨运行时数据导出/导入的契约
 * 支持个人、团队、企业三种导出模式
 */

import { z } from 'zod';

const TenantInfoSchema = z.object({
  tenantId: z.string().min(1),
  deploymentMode: z.enum(['platform_managed', 'shared_cluster', 'dedicated_db', 'self_hosted']),
  encryptionMode: z.enum(['platform_managed', 'tenant_dedicated']),
  kmsKeyRef: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.encryptionMode === 'tenant_dedicated' && !value.kmsKeyRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kmsKeyRef'],
      message: 'tenant_dedicated 加密模式必须提供 kmsKeyRef',
    });
  }
});

const PayloadEntrySchema = z.object({
  logicalName: z.string().min(1),
  format: z.enum(['ndjson', 'json']),
  path: z.string().min(1),
  checksum: z.string().min(1),
  required: z.boolean(),
}).strict();

const BlobEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
}).strict();

const CompatibilitySchema = z.object({
  minImporterVersion: z.string().min(1),
  featureFlagsRequired: z.array(z.string()),
}).strict();

const IntegritySchema = z.object({
  algorithm: z.enum(['sha256', 'sha384']),
  manifestChecksum: z.string().min(1),
  signatureAlgorithm: z.enum(['ed25519', 'rsa-pss', 'hmac-sha256']),
  signaturePublicKey: z.string().min(1),
  detachedSignaturePath: z.string().min(1),
}).strict();

const EncryptionSchema = z.object({
  mode: z.enum(['passphrase', 'kms-wrapped', 'none']),
  kdf: z.enum(['argon2id', 'scrypt']).optional(),
  kmsKeyRef: z.string().optional(),
  wrappedDataKeyPath: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'passphrase' && !value.kdf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kdf'],
      message: 'passphrase 模式必须指定 kdf 算法',
    });
  }
  if (value.mode === 'passphrase' && value.kmsKeyRef !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kmsKeyRef'],
      message: 'passphrase 模式不能包含 kmsKeyRef',
    });
  }
  if (value.mode === 'passphrase' && value.wrappedDataKeyPath !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wrappedDataKeyPath'],
      message: 'passphrase 模式不能包含 wrappedDataKeyPath',
    });
  }
  if (value.mode === 'kms-wrapped' && !value.kmsKeyRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kmsKeyRef'],
      message: 'kms-wrapped 模式必须指定 kmsKeyRef',
    });
  }
  if (value.mode === 'kms-wrapped' && !value.wrappedDataKeyPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wrappedDataKeyPath'],
      message: 'kms-wrapped 模式必须指定 wrappedDataKeyPath',
    });
  }
  if (value.mode === 'kms-wrapped' && value.kdf !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kdf'],
      message: 'kms-wrapped 模式不能包含 kdf',
    });
  }
  if (value.mode === 'none' && value.kdf !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kdf'],
      message: 'none 模式不能包含 kdf',
    });
  }
  if (value.mode === 'none' && value.kmsKeyRef !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kmsKeyRef'],
      message: 'none 模式不能包含 kmsKeyRef',
    });
  }
  if (value.mode === 'none' && value.wrappedDataKeyPath !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wrappedDataKeyPath'],
      message: 'none 模式不能包含 wrappedDataKeyPath',
    });
  }
});

export const PortabilityPackManifestV1Schema = z.object({
  schemaVersion: z.literal('portability-pack.v1'),
  exportedAt: z.string().datetime({ offset: true }),
  exportMode: z.enum(['personal', 'smb', 'enterprise']),
  sourceRuntime: z.enum(['node', 'web', 'mobile', 'desktop']),
  sourceApiMajor: z.enum(['v1', 'v2']),
  tenant: TenantInfoSchema,
  payloads: z.array(PayloadEntrySchema).min(1),
  blobs: z.array(BlobEntrySchema).optional(),
  compatibility: CompatibilitySchema,
  integrity: IntegritySchema,
  encryption: EncryptionSchema.optional(),
}).strict();

const WarningSchema = z.object({
  code: z.string().min(1),
  messageId: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
}).strict();

export const ExportJobStatusV1Schema = z.object({
  schemaVersion: z.literal('export-job-status.v1'),
  exportId: z.string().min(1),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'partial']),
  percent: z.number().min(0).max(100),
  etaMs: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  downloadUrl: z.string().optional(),
  errorCode: z.string().optional(),
  warnings: z.array(WarningSchema),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'completed') {
    if (value.percent !== 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['percent'], message: 'completed 状态必须为 100%' });
    }
    if (!value.completedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'completed 状态必须包含 completedAt' });
    }
    if (!value.downloadUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['downloadUrl'], message: 'completed 状态必须包含 downloadUrl' });
    }
    if (value.errorCode !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'completed 状态不能包含 errorCode' });
    }
  }
  if (value.state === 'failed') {
    if (!value.completedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'failed 状态必须包含 completedAt' });
    }
    if (!value.errorCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'failed 状态必须包含 errorCode' });
    }
    if (value.downloadUrl !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['downloadUrl'], message: 'failed 状态不能包含 downloadUrl' });
    }
  }
  if (value.state === 'partial') {
    if (!value.completedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'partial 状态必须包含 completedAt' });
    }
    if (value.downloadUrl !== undefined && !value.completedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['downloadUrl'], message: 'partial 状态的 downloadUrl 仅在终止后有效' });
    }
  }
  if ((value.state === 'queued' || value.state === 'running') && value.completedAt !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: '非终态任务不能包含 completedAt' });
  }
  if ((value.state === 'queued' || value.state === 'running') && value.downloadUrl !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['downloadUrl'], message: '非终态任务不能包含 downloadUrl' });
  }
  if ((value.state === 'queued' || value.state === 'running') && value.errorCode !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: '非终态任务不能包含 errorCode' });
  }
});

const BlockerOrWarningSchema = z.object({
  code: z.string().min(1),
  messageId: z.string().min(1),
  entity: z.string().optional(),
}).strict();

const DeltaSummaryEntrySchema = z.object({
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative(),
}).strict();

export const ImportDryRunReportV1Schema = z.object({
  schemaVersion: z.literal('import-dryrun.v1'),
  importId: z.string().min(1),
  packSchemaVersion: z.string().min(1),
  signatureValid: z.boolean(),
  blockers: z.array(BlockerOrWarningSchema),
  warnings: z.array(BlockerOrWarningSchema),
  deltaSummary: z.record(z.string(), DeltaSummaryEntrySchema),
  estimatedDurationMs: z.number().int().nonnegative(),
  canCommit: z.boolean(),
  commitToken: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.canCommit) {
    if (!value.signatureValid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['canCommit'], message: '签名无效时不能允许 commit' });
    }
    if (value.blockers.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blockers'], message: '存在 blockers 时不能允许 commit' });
    }
    if (!value.commitToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commitToken'], message: 'canCommit=true 时必须提供 commitToken' });
    }
  } else if (value.commitToken !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commitToken'], message: 'canCommit=false 时不应返回 commitToken' });
  }
});

export type PortabilityPackManifestV1 = z.infer<typeof PortabilityPackManifestV1Schema>;
export type ExportJobStatusV1 = z.infer<typeof ExportJobStatusV1Schema>;
export type ImportDryRunReportV1 = z.infer<typeof ImportDryRunReportV1Schema>;
