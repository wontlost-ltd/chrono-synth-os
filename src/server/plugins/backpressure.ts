/**
 * Per-tenant request concurrency cap — backpressure to prevent a single
 * tenant from exhausting backend resources during a burst.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.6 P1-O-abuse
 *
 * Complements (does NOT replace) the existing token-bucket rate limit:
 *   - rate limit  → "you can issue X requests per minute" (long-term avg)
 *   - backpressure → "I will only serve Y of yours at the same time"
 *                    (short-burst protection; rejects the surplus with
 *                     429 + Retry-After ~= currently estimated drain time)
 *
 * Why per-tenant: a single tenant slamming the API with concurrent
 * uploads should NOT degrade SLA for the other 99 tenants. Per-tenant
 * caps are a poor man's tenant SLA isolation until P1-R-tenant-iso
 * splits the request pool by tenant at the worker level.
 *
 * Bounded memory: the in-flight map only carries currently-executing
 * counts; never grows beyond the active tenant count. No timer-based
 * eviction needed.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface BackpressureOptions {
  /** Hard cap on concurrent in-flight requests for any single tenant. */
  maxConcurrentPerTenant: number;
  /** When exceeded, hint to client how long until capacity probably frees up. */
  retryAfterSeconds: number;
  /** Resolve a tenant id from the request; null = unbounded (anonymous traffic). */
  resolveTenantId(request: FastifyRequest): string | null;
}

export const DEFAULT_BACKPRESSURE: Pick<BackpressureOptions, 'maxConcurrentPerTenant' | 'retryAfterSeconds'> = {
  maxConcurrentPerTenant: 32,
  retryAfterSeconds: 1,
};

interface InFlightState {
  count: number;
}

export interface BackpressureSnapshot {
  /** For diagnostics + observability dashboards. */
  inFlightByTenant: ReadonlyMap<string, number>;
  totalInFlight: number;
}

export interface BackpressureController {
  snapshot(): BackpressureSnapshot;
}

export function registerBackpressure(
  app: FastifyInstance,
  options: BackpressureOptions,
): BackpressureController {
  const inFlight = new Map<string, InFlightState>();

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = options.resolveTenantId(request);
    if (!tenantId) return;
    const state = inFlight.get(tenantId) ?? { count: 0 };
    if (state.count >= options.maxConcurrentPerTenant) {
      reply.header('Retry-After', String(options.retryAfterSeconds));
      return reply.status(429).send({
        error: 'BackpressureError',
        code: 'TENANT_CONCURRENCY_LIMIT',
        message: `Tenant ${tenantId} has ${state.count} concurrent requests; cap is ${options.maxConcurrentPerTenant}. Slow your request rate.`,
        retryAfter: options.retryAfterSeconds,
      });
    }
    state.count += 1;
    inFlight.set(tenantId, state);
    /* Mark the request so onResponse can decrement; use a Symbol-like
     * key to avoid clobbering caller-supplied fields. */
    (request as FastifyRequest & { _backpressureTenant?: string })._backpressureTenant = tenantId;
  });

  app.addHook('onResponse', async (request: FastifyRequest) => {
    const tenantId = (request as FastifyRequest & { _backpressureTenant?: string })._backpressureTenant;
    if (!tenantId) return;
    const state = inFlight.get(tenantId);
    if (!state) return;
    state.count = Math.max(0, state.count - 1);
    if (state.count === 0) inFlight.delete(tenantId);
  });

  /* If the response never reaches onResponse (handler threw, connection
   * dropped mid-flight), Fastify's onTimeout / onError hooks still need
   * to release the slot. Otherwise a single client closing connections
   * during a burst could pin the counter at the cap forever. */
  app.addHook('onError', async (request: FastifyRequest) => {
    const tenantId = (request as FastifyRequest & { _backpressureTenant?: string })._backpressureTenant;
    if (!tenantId) return;
    const state = inFlight.get(tenantId);
    if (!state) return;
    state.count = Math.max(0, state.count - 1);
    if (state.count === 0) inFlight.delete(tenantId);
  });

  return {
    snapshot(): BackpressureSnapshot {
      const map = new Map<string, number>();
      let total = 0;
      for (const [k, v] of inFlight) {
        map.set(k, v.count);
        total += v.count;
      }
      return { inFlightByTenant: map, totalInFlight: total };
    },
  };
}
