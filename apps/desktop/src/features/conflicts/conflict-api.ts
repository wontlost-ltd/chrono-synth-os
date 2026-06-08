/**
 * Conflict-inbox API client.
 *
 * Thin wrapper over `apiFetch` that pins request/response shapes to the
 * @chrono/contracts schemas. The contract schemas already enforce
 * superRefine rules (e.g. `merge_manually` requires `mergePayload`); we
 * just parse on the boundary so a stale build can't get away with sending
 * an invalid payload.
 *
 * Why a dedicated file:
 *   - The 5 resolution-panel components all need the same `resolve()`
 *     call. Inlining it in each panel would duplicate validation +
 *     `if-match` plumbing across 5 sites.
 *   - Telemetry hooks (see ./telemetry) wrap these calls; isolating the
 *     network surface keeps the telemetry concerns out of the UI files.
 */

import {
  ConflictInboxItemV1Schema,
  ConflictResolveRequestV1Schema,
  ConflictResolveResultV1Schema,
  type ConflictInboxItemV1,
  type ConflictResolveResultV1,
} from '@chrono/contracts';
import { z } from 'zod';
import { apiFetch } from '../../bridge/http-client';

const ConflictsListEnvelopeSchema = z.object({
  data: z.array(ConflictInboxItemV1Schema),
});

const ConflictSingleEnvelopeSchema = z.object({
  data: ConflictInboxItemV1Schema,
});

const ConflictResolveEnvelopeSchema = z.object({
  data: ConflictResolveResultV1Schema,
});

/** GET /api/v1/conflicts — paginated list, but we only need first page. */
export async function listConflicts(): Promise<ConflictInboxItemV1[]> {
  const raw = await apiFetch<unknown>('/api/v1/conflicts');
  return ConflictsListEnvelopeSchema.parse(raw).data;
}

/** GET /api/v1/conflicts/:conflictId — single conflict for the detail view. */
export async function getConflict(conflictId: string): Promise<ConflictInboxItemV1> {
  const raw = await apiFetch<unknown>(`/api/v1/conflicts/${encodeURIComponent(conflictId)}`);
  return ConflictSingleEnvelopeSchema.parse(raw).data;
}

export interface ResolveInput {
  conflictId: string;
  ifMatch: string;
  action: 'keep_local' | 'keep_server' | 'duplicate' | 'merge_manually';
  mergePayload?: Record<string, unknown>;
}

/** Extract HTTP status from an error message produced by `apiFetch`.
 *  apiFetch throws `Error('HTTP NNN: <body excerpt>')` on non-2xx,
 *  with no structured field. We parse the prefix here so callers can
 *  distinguish 409 (stale conflict) from 400 (bad payload), 401
 *  (auth), and 404 (gone) — string-includes-based matching would
 *  treat all 4xx as the same case and route real errors to the
 *  stale-refresh path. */
export function getHttpStatus(err: unknown): number | null {
  if (!err) return null;
  if (err instanceof Error) {
    const match = /^HTTP\s+(\d{3})\b/.exec(err.message);
    if (match) return Number(match[1]);
  }
  return null;
}

/** POST /api/v1/conflicts/:conflictId/resolve — atomic resolve.
 *  Server returns 409 if ifMatch doesn't match the current
 *  conflictVersion — that means someone else (or another tab) already
 *  resolved it and the UI must reload. */
export async function resolveConflict(input: ResolveInput): Promise<ConflictResolveResultV1> {
  /* Parse on the request boundary so an obviously-invalid input
   * (merge_manually without payload) fails before the network round trip. */
  const body = ConflictResolveRequestV1Schema.parse(input);
  const raw = await apiFetch<unknown>(`/api/v1/conflicts/${encodeURIComponent(input.conflictId)}/resolve`, {
    method: 'POST',
    body,
  });
  return ConflictResolveEnvelopeSchema.parse(raw).data;
}
