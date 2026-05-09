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

/* ──────────────────────────────────────────────────────────────────────
 * Canonicalization (RFC 8785 subset) + §9 checksum.
 *
 * The TypeScript and Python (reference-impls/python/chrono_ppf) impls
 * share this contract: feed the same vector through both, the
 * `provenance.checksum`-style hash bytes MUST match. The shared test
 * vector pins the expected hash (see test-vectors/README.md), so a
 * change in either canonicalizer fails CI in both ecosystems.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Sort object keys recursively and re-serialize without spaces, mirroring
 * the Python `chrono_ppf.canonical.canonicalize` output byte-for-byte.
 *
 * Limitations: PPF v1 only emits ASCII keys, finite numbers in [0, 1] or
 * non-negative integers, and bounded UTF-8 strings — so we don't need
 * full RFC 8785 number canonicalization or UTF-16 code-unit sorting.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalize(doc: unknown): string {
  return JSON.stringify(sortKeysDeep(doc));
}

/* Minimal ambient declarations: this package targets ES2024 with no DOM
 * lib so it can ship to web, Tauri, and Node consumers identically. The
 * declarations below pin only the surface we actually call. */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
interface SubtleLike {
  digest(algorithm: 'SHA-256', data: ArrayBufferView): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle?: SubtleLike;
}
declare const globalThis: { crypto?: CryptoLike };

/**
 * Compute the spec-§9 checksum: SHA-256 over the canonical bytes of the
 * document with `signature` set to `null`.
 *
 * Uses the platform crypto.subtle when available (Node 19+, all evergreen
 * browsers). Throws if neither is present — we deliberately do not fall
 * back to a JS sha256, since this hash is consensus-critical and a JS
 * polyfill would just add a second canonicalizer to keep in sync.
 */
export async function documentChecksum(doc: PpfV1Document): Promise<string> {
  const snapshot = { ...doc, signature: null } as const;
  const bytes = new TextEncoder().encode(canonicalize(snapshot));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('crypto.subtle is not available; cannot compute PPF checksum');
  }
  const digest = await subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:0x${hex}`;
}
