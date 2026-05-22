/**
 * 发布清单契约 v1 — 发布流水线（chrono-synth-deploy）与运行时
 * （chrono-synth-os GA blocker 审计）共同遵守的 "可发布版本" 定义。
 *
 * 一份合法的 ReleaseManifestV1 至少包含：
 *   - 不可变的版本标识（gitSha、releaseId、builtAt）；
 *   - 至少一份产物（容器、tarball、binary、helm chart 或 SBOM）；
 *   - 至少一份 cosign keyless OIDC 签名（覆盖 primary container）；
 *   - 一个独立 SBOM 引用；
 *   - 构建期 feature flag 默认值快照（部署时核对漂移）；
 *   - 迁移头版本与期望生效集合（防止运行时 schema 漂移）；
 *   - 兼容性下限（web / desktop / schema）。
 *
 * `slsaProvenance` 可选 — Phase 1A 起开始要求，Phase 1B 强制。
 */

import { z } from 'zod';

const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const ArtifactSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['container', 'tarball', 'binary', 'helm-chart', 'sbom']),
  digest: Sha256DigestSchema,
  size: z.number().int().nonnegative(),
}).strict();

const SignatureSchema = z.object({
  subject: z.string().min(1),
  signedBy: z.string().min(1),
  signatureRef: z.string().min(1),
  alg: z.string().min(1),
}).strict();

const SlsaProvenanceSchema = z.object({
  predicateType: z.literal('https://slsa.dev/provenance/v1'),
  ref: z.string().min(1),
}).strict();

const MigrationsSchema = z.object({
  headVersion: z.number().int().nonnegative(),
  expectedAfter: z.array(z.number().int().nonnegative()),
}).strict();

const CompatibilitiesSchema = z.object({
  webMinVersion: z.string().min(1),
  desktopMinVersion: z.string().min(1),
  schemaMinVersion: z.number().int().nonnegative(),
}).strict();

export const ReleaseManifestV1Schema = z.object({
  manifestVersion: z.literal('v1'),
  releaseId: z.string().uuid(),
  gitSha: GitShaSchema,
  builtAt: z.string().datetime(),
  artifacts: z.array(ArtifactSchema).min(1),
  /** 至少包含 primary container 的 cosign keyless OIDC 签名。 */
  signatures: z.array(SignatureSchema).min(1),
  sbomRef: z.string().min(1),
  slsaProvenance: SlsaProvenanceSchema.optional(),
  featureFlagSnapshot: z.record(z.string(), z.boolean()),
  migrations: MigrationsSchema,
  compatibilities: CompatibilitiesSchema,
}).strict().superRefine((manifest, ctx) => {
  /* 至少一条 signatures.subject 必须以容器制品的 `@<digest>` 结尾，
   * 否则发布清单是"含未签容器"的非法状态。这是与 supply-chain
   * 监管（SLSA L3+）对齐的强约束，签名漂移会破坏验证链。 */
  const containerDigests = manifest.artifacts
    .filter(artifact => artifact.kind === 'container')
    .map(artifact => artifact.digest);
  if (containerDigests.length === 0) return;
  const hasContainerSignature = manifest.signatures.some(signature =>
    containerDigests.some(digest => signature.subject.endsWith(`@${digest}`)),
  );
  if (!hasContainerSignature) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['signatures'],
      message: 'at least one signature must cover a container artifact digest (subject must end with @<digest>)',
    });
  }
});

/**
 * 部署侧的轻量引用 — 仅指向真实的 manifest 副本（位于产物仓 / OCI
 * registry），运行时即可凭 sha256 校验完整性，无需下载完整对象。
 */
export const ReleaseManifestRefSchema = z.object({
  manifestVersion: z.literal('v1'),
  releaseId: z.string().uuid(),
  sha256: Sha256HexSchema,
}).strict();

export type ReleaseManifestV1 = z.infer<typeof ReleaseManifestV1Schema>;
export type ReleaseManifestRef = z.infer<typeof ReleaseManifestRefSchema>;
