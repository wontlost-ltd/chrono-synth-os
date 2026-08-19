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

  /* handler 抛错时响应走 onError 而非只走 onResponse，同样要还 slot，
   * 否则错误请求会把计数器永久顶在 cap 上。两个钩子共用 release()，
   * 由标记保证只减一次。
   *
   * ⚠️ 刻意**不**注册 onTimeout：它是 socket 级超时（且需配 connectionTimeout，
   * 本仓当前未配置，默认 0 = 禁用），触发时 Fastify **并不会取消仍在执行的
   * handler**。在那里还 slot 会让新请求进来，而旧请求还在占数据库/CPU——
   * 恰好破坏 cap 想守住的资源上限。客户端中途断连是另一个钩子
   * （onRequestAbort），语义也不同。两者都需要先定义「slot 代表连接还是
   * 后端工作」再单独处理，不在本次修复范围内。 */
  app.addHook('onError', async (request: FastifyRequest) => release(request));

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
