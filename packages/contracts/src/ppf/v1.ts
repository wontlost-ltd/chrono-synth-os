/**
 * PPF (Persona Portable Format) v1 — runtime validation schemas
 *
 * Mirrors docs/ppf/v1/spec.md. Use these to validate PPF documents at
 * import boundaries and to drive the byte-stable hash check.
 *
 * Source of truth: docs/ppf/v1/spec.md. If this file disagrees with the
 * spec, the spec wins and this file is the bug.
 */

import { z } from 'zod';

export const PPF_V1_CONTEXT = 'https://chrono-synth.dev/ppf/v1' as const;
export const PPF_V1_VERSION = '1.0' as const;

const epochMs = z.number().int().nonnegative();
const ratio01 = z.number().min(0).max(1);

const PpfValueSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  weight: ratio01,
}).strict();

const PpfNarrativeSchema = z.object({
  primary: z.string().min(1).max(4096),
  additional: z.array(z.string().max(1024)).default([]),
}).strict();

const PpfMemoryNodeSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['fact', 'event', 'belief', 'relationship', 'goal']),
  summary: z.string().min(1).max(1024),
  confidenceScore: ratio01,
  unverified: z.boolean(),
  sourceKind: z.enum(['user_input', 'system_inferred', 'api_sync', 'unknown']),
  createdAt: epochMs,
  updatedAt: epochMs,
  tenantScope: z.string().min(1).max(128),
}).strict();

const PpfMemoryEdgeSchema = z.object({
  from: z.string().min(1).max(128),
  to: z.string().min(1).max(128),
  relation: z.string().min(1).max(64),
  weight: ratio01,
}).strict();

const PpfMemorySchema = z.object({
  schema: z.literal('memory-node.v1'),
  nodes: z.array(PpfMemoryNodeSchema),
  edges: z.array(PpfMemoryEdgeSchema),
}).strict();

const PpfToolsSchema = z.object({
  allowed: z.array(z.string().min(1).max(128)),
  denied: z.array(z.string().min(1).max(128)),
}).strict();

const PpfGovernanceSchema = z.object({
  driftThreshold: z.object({
    warning: ratio01,
    critical: ratio01,
  }).strict().refine((v) => v.critical > v.warning, {
    message: 'driftThreshold.critical must be > driftThreshold.warning',
  }),
  hallucinationPolicy: z.enum(['block', 'flag_and_confirm', 'log_only']),
  retentionDays: z.number().int().min(7),
  requireConfirmationFor: z.array(z.string().min(1).max(128)),
}).strict();

const PpfProvenanceSchema = z.object({
  exportedBy: z.string().min(1).max(128),
  exportReason: z.string().min(1).max(256),
  /** sha256 of canonical document with `signature` set to null */
  checksum: z.string().regex(/^sha256:0x[0-9a-f]{64}$/i),
}).strict();

const PpfSignatureSchema = z.object({
  alg: z.literal('Ed25519'),
  keyId: z.string().min(1).max(256),
  signedAt: epochMs,
  /** base64url-encoded signature bytes */
  value: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const PpfV1DocumentSchema = z.object({
  '@context': z.literal(PPF_V1_CONTEXT),
  '@type': z.literal('PersonaKernel'),
  id: z.string().regex(/^did:chrono:[a-z2-7]{8,}$/, 'id must be did:chrono:<base32>'),
  version: z.literal(PPF_V1_VERSION),
  createdAt: epochMs,
  exportedAt: epochMs,
  sourceInstance: z.string().min(1).max(512),
  values: z.array(PpfValueSchema),
  narrative: PpfNarrativeSchema,
  memory: PpfMemorySchema,
  capabilities: z.array(z.string().min(1).max(64)),
  tools: PpfToolsSchema,
  governance: PpfGovernanceSchema,
  provenance: PpfProvenanceSchema,
  signature: PpfSignatureSchema.nullable(),
}).strict().superRefine((doc, ctx) => {
  /* Spec §4: values MUST be sorted by (-weight, id) for byte-stable hashing */
  for (let i = 1; i < doc.values.length; i++) {
    const prev = doc.values[i - 1]!;
    const curr = doc.values[i]!;
    const inOrder = prev.weight > curr.weight || (prev.weight === curr.weight && prev.id <= curr.id);
    if (!inOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values', i],
        message: 'values must be sorted by weight desc, then id asc',
      });
      return;
    }
  }
  /* Spec §6: memory.nodes sorted by createdAt asc */
  for (let i = 1; i < doc.memory.nodes.length; i++) {
    if (doc.memory.nodes[i - 1]!.createdAt > doc.memory.nodes[i]!.createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memory', 'nodes', i],
        message: 'memory.nodes must be sorted by createdAt asc',
      });
      return;
    }
  }
});

export type PpfV1Document = z.infer<typeof PpfV1DocumentSchema>;
export type PpfValue = z.infer<typeof PpfValueSchema>;
export type PpfMemoryNode = z.infer<typeof PpfMemoryNodeSchema>;
export type PpfGovernance = z.infer<typeof PpfGovernanceSchema>;
