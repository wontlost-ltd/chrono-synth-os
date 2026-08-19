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

  /**
   * 释放 slot —— **exactly-once**。
   *
   * ⚠️ 必须清掉 `_backpressureTenant` 标记：handler 抛错时 Fastify 会**先跑
   * onError、再跑 onResponse**，两个钩子都命中同一请求。不清标记就会**减两次**，
   * 把**别的在途请求**的 slot 也一并释放掉（`Math.max(0, …)` 只防负数，
   * 防不住这个）。后果是并发计数偏低、租户可以突破 cap —— 滥用保护静默失效。
   *
   * 清标记后谁先跑谁释放，后到的那个 `!tenantId` 直接返回。
   */
  const release = (request: FastifyRequest): void => {
    const marked = request as FastifyRequest & { _backpressureTenant?: string };
    const tenantId = marked._backpressureTenant;
    if (!tenantId) return;
    marked._backpressureTenant = undefined;
    const state = inFlight.get(tenantId);
    if (!state) return;
    state.count = Math.max(0, state.count - 1);
    if (state.count === 0) inFlight.delete(tenantId);
  };

  app.addHook('onResponse', async (request: FastifyRequest) => release(request));

  /* 响应走不到 onResponse 的路径（handler 抛错、连接中途断开、请求超时）
   * 同样要还 slot，否则一个客户端在 burst 中不断断连就能把计数器永久顶在
   * cap 上。三个钩子共用 release()，由标记保证只减一次。 */
  app.addHook('onError', async (request: FastifyRequest) => release(request));
  app.addHook('onTimeout', async (request: FastifyRequest) => release(request));

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
