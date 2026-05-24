/**
 * Feature flag API — bootstrap snapshot + live SSE stream.
 *
 * 由 chrono-synth-web 的 FeatureFlagProvider 消费。流程：
 *   1. 客户端启动时 GET /api/v1/feature-flags/bootstrap，
 *      拿到全部当前 flag 的初始决策（已根据 caller tenantId 解析过
 *      kill-switch / allowlist / rolloutPercent）。
 *   2. 同时打开 GET /api/v1/feature-flags/stream（SSE），
 *      监听 `feature-flag:changed` 事件。
 *   3. 任一 flag mutation（admin 翻转 / kill switch / rollout 调整）
 *      会触发 bus event → SSE 推送 → 客户端 setFlagValue() 更新缓存。
 *   4. 客户端断开 SSE 时保留最近一次值，并标记为 stale。
 *
 * 设计取舍：
 *   - 只暴露 `web.*` 命名空间的 flag。Server-side flag（`agent.*`,
 *     `audit.*` 等）通过 worker 内的 isEnabled() 决策，不需要也不
 *     应该让 web 客户端看到。
 *   - SSE 比 WebSocket 简单 — 单向、自动重连，浏览器原生 EventSource
 *     支持。Kill switch 推送的最大延迟 = 一次网络往返 + 客户端事件循环。
 *   - 鉴权与 `routes/sse.ts` 保持一致：jwt.enabled 时强制；否则放行
 *     允许本地开发未登录访问。
 */

import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import { FEATURE_FLAGS, type FlagKey } from '../../feature-flags/feature-flag-service.js';

/** 仅 web.* flag 对外暴露。后端 flag 永远不进 SSE / bootstrap 响应。 */
function isWebFlag(flag: string): flag is FlagKey {
  return flag.startsWith('web.') && flag in FEATURE_FLAGS;
}

/** web.* flag id → web 客户端的 FeatureFlagId（剥掉 `web.` 前缀）。
 *  Web 端的 type union 没有 `web.` 前缀（历史原因），统一在这里转换
 *  以便服务端 flag 重命名时只影响一个文件。 */
function stripWebPrefix(flag: FlagKey): string {
  return flag.startsWith('web.') ? flag.slice('web.'.length) : flag;
}

/** 写一行 SSE 事件。`id` 字段用 Date.now()，客户端可以 Last-Event-ID
 *  重连时声明已收到的最新事件 — 我们不持久化历史所以客户端只能丢弃。 */
function writeSseEvent(raw: ServerResponse, event: string, data: unknown): void {
  raw.write(`id: ${Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeSseComment(raw: ServerResponse, comment: string): void {
  raw.write(`: ${comment}\n\n`);
}

interface BootstrapEntry {
  flag: string;         /* 已剥前缀，与 web FeatureFlagId 一致 */
  value: boolean;       /* 当前最终决策（已考虑 kill/allowlist/rollout） */
  source: 'remote';     /* 客户端可据此辨别值的来源 */
}

interface ChangeEntry {
  flag: string;
  value: boolean;
}

/** Active SSE connection count for this endpoint. Bounded by
 *  config.sse?.maxConnectionsPerTenant × 10 to mirror the
 *  /api/v1/events/stream cap. Prevents reconnect storms (e.g. a
 *  client-side bug that thrashes EventSource) from leaking bus
 *  listeners and heartbeat intervals. Module-scoped so the counter
 *  survives across requests. */
let featureFlagSseConnectionCount = 0;

/* Test hook — only reset between integration tests. */
export function _resetFeatureFlagSseConnectionCountForTest(): void {
  featureFlagSseConnectionCount = 0;
}

export function registerFeatureFlagRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  config: AppConfig,
): void {
  /* ── Bootstrap：一次性返回当前所有 web flag 的决策 ────────────── */
  app.get('/api/v1/feature-flags/bootstrap', async (request, reply) => {
    const user = request.user as JwtPayload | undefined;
    if (config.jwt.enabled && !user?.sub) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const tenantId = user?.tenantId ?? request.tenantId ?? null;

    const flags: BootstrapEntry[] = [];
    for (const key of Object.keys(FEATURE_FLAGS) as FlagKey[]) {
      if (!isWebFlag(key)) continue;
      const decision = os.featureFlags.isEnabled(key, tenantId);
      flags.push({
        flag: stripWebPrefix(key),
        value: decision.enabled,
        source: 'remote',
      });
    }

    return reply.send({ flags });
  });

  /* ── Stream：订阅 mutation 事件 ──────────────────────────────── */
  app.get('/api/v1/feature-flags/stream', async (request, reply) => {
    const user = request.user as JwtPayload | undefined;
    if (config.jwt.enabled && !user?.sub) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const tenantId = user?.tenantId ?? request.tenantId ?? null;

    /* 连接上限：与 /api/v1/events/stream 保持一致的策略
     * (maxConnectionsPerTenant × 10 作为全局上限的粗略估计)。
     * 触达上限时返回 503 — EventSource 会按指数退避重连。 */
    const maxConns = config.sse?.maxConnectionsPerTenant ?? 50;
    if (featureFlagSseConnectionCount >= maxConns * 10) {
      return reply.code(503).send({ error: 'SSE connection limit reached' });
    }
    featureFlagSseConnectionCount++;

    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      /* 避免反向代理（nginx / Cloudflare）缓冲 SSE chunks。 */
      'X-Accel-Buffering': 'no',
    });

    /* 连上即推送当前快照。客户端拿到 'snapshot' 事件后可以丢弃
     * bootstrap 结果（两条路径有竞争时以 stream 为准），或者用它
     * 校验 bootstrap 是否被中间件改写。 */
    const initial: BootstrapEntry[] = [];
    for (const key of Object.keys(FEATURE_FLAGS) as FlagKey[]) {
      if (!isWebFlag(key)) continue;
      const decision = os.featureFlags.isEnabled(key, tenantId);
      initial.push({
        flag: stripWebPrefix(key),
        value: decision.enabled,
        source: 'remote',
      });
    }
    writeSseEvent(raw, 'snapshot', { flags: initial });

    /* 订阅 mutation 事件。注意：决策结果依赖 tenantId（rollout 桶 +
     * allowlist），所以每次事件都要重新跑 isEnabled() 而不是直接
     * forward payload.enabled。
     *
     * 副作用：同一 tenantId 在 rollout 边界附近翻转时（例如
     * rollout: 49 → 51, tenant 桶 = 50）每个 tenant 看到的最终值不同 —
     * 这是正确行为，正是 rollout 的目的。 */
    const onChanged = (payload: { flag: string }): void => {
      const flag = payload.flag;
      if (!isWebFlag(flag)) return;
      const decision = os.featureFlags.isEnabled(flag, tenantId);
      const entry: ChangeEntry = {
        flag: stripWebPrefix(flag),
        value: decision.enabled,
      };
      writeSseEvent(raw, 'change', entry);
    };
    os.bus.on('feature-flag:changed', onChanged);

    /* 心跳。EventSource 默认无 keepalive，proxies 经常砍掉 60s 静默
     * 连接。SSE 注释行（`: comment`）不触发 onmessage，纯粹保活。 */
    const heartbeat = setInterval(() => {
      writeSseComment(raw, 'keepalive');
    }, config.websocket.heartbeatIntervalMs);

    /* 清理。`request.raw.close` 在客户端断开 / network drop 时触发。
     * Idempotent — Node 触发 close+error 时不重复递减连接计数 / 重复
     * 摘除监听器。 */
    let cleaned = false;
    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      featureFlagSseConnectionCount--;
      clearInterval(heartbeat);
      os.bus.off('feature-flag:changed', onChanged);
      if (!raw.writableEnded) raw.end();
    }

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
