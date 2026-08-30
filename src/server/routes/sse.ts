/**
 * SSE 事件流路由
 * GET /api/v1/events/stream — 通过 Server-Sent Events 推送系统事件
 * 复用 WebSocket 插件的事件缓冲、持久化回放和租户隔离逻辑
 */

import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { SystemEventName, SystemEventMap } from '../../types/events.js';
import type { JwtPayload } from '../../types/auth.js';
import {
  VALID_EVENTS,
  bufferEvent,
  getPersistedEventsSince,
  getBufferedEventsSince,
  getOldestBufferedSeq,
  currentGlobalSeq,
} from '../plugins/websocket.js';

/**
 * SSE 活跃连接计数。
 *
 * ⚠️ 审计 #440-3：此前只有这一个**全局**计数器，准入判据是
 * `sseConnectionCount >= maxConns * 10`，而配置项名叫
 * `maxConnectionsPerTenant` —— `tenantId` 算出来只用于事件过滤，
 * **从不参与准入**。于是任何一个租户开满全局额度，其余所有租户一律 503：
 * 名为 per-tenant 的配额实际是先到先得的公共池，一个租户即可拖垮全部。
 *
 * 改为按租户记账：每租户各自 `maxConnectionsPerTenant` 条上限，
 * 另保留一个全局总量上限防止租户数本身把进程拖垮。
 */
const sseConnectionsByTenant = new Map<string, number>();
let sseConnectionCount = 0;
export function getSseConnectionCount(): number { return sseConnectionCount; }
/** 某租户当前活跃 SSE 连接数（测试与运维观测用）。 */
export function getSseConnectionCountForTenant(tenantId: string): number {
  return sseConnectionsByTenant.get(tenantId) ?? 0;
}
/** 仅供测试重置模块级计数（避免用例间互相污染）。 */
export function __resetSseConnectionCounts(): void {
  sseConnectionsByTenant.clear();
  sseConnectionCount = 0;
}

function writeSseEvent(raw: ServerResponse, seq: number, event: string, data: unknown): void {
  raw.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeSseComment(raw: ServerResponse, comment: string): void {
  raw.write(`: ${comment}\n\n`);
}

export function registerSseRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  config: AppConfig,
): void {
  app.get('/api/v1/events/stream', async (request, reply) => {
    /* JWT 鉴权 */
    const user = request.user as JwtPayload | undefined;
    if (config.jwt.enabled && !user?.sub) {
      return reply.code(401).send({ error: '需要认证' });
    }

    const tenantId = user?.tenantId ?? request.tenantId ?? 'default';
    const query = request.query as Record<string, string>;

    /* SSE 连接数限制：先判本租户配额，再判全局总量。
     *
     * 全局上限保留 `maxConns * 10` 这个既有余量（它原本是唯一判据），
     * 现在退化为「防止租户数本身把进程拖垮」的兜底，而不再是单个租户
     * 就能吃满的公共池。 */
    const maxConns = config.sse?.maxConnectionsPerTenant ?? 50;
    const tenantConns = sseConnectionsByTenant.get(tenantId) ?? 0;
    if (tenantConns >= maxConns) {
      return reply.code(503).send({ error: 'SSE 连接数已达本租户上限' });
    }
    if (sseConnectionCount >= maxConns * 10) {
      return reply.code(503).send({ error: 'SSE 连接数已达全局上限' });
    }

    sseConnectionCount++;
    sseConnectionsByTenant.set(tenantId, tenantConns + 1);

    /* 设置 SSE 响应头 */
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    /* Replay：如提供 sinceSeq，回放缓冲/持久化事件 */
    const sinceSeq = Number(query.sinceSeq) || 0;
    if (sinceSeq > 0) {
      const oldestSeq = getOldestBufferedSeq();
      let missed: Array<{ seq: number; event: string; data: unknown }>;

      if (oldestSeq !== null && sinceSeq < oldestSeq) {
        missed = getPersistedEventsSince(sinceSeq, tenantId);
      } else {
        missed = getBufferedEventsSince(sinceSeq, tenantId);
      }

      for (const entry of missed) {
        writeSseEvent(raw, entry.seq, entry.event, entry.data);
      }
      writeSseComment(raw, `replay-complete lastSeq=${currentGlobalSeq()} replayed=${missed.length}`);
    }

    /* 事件过滤：可选 events 参数（逗号分隔） */
    const eventFilter = query.events
      ? new Set(query.events.split(',').filter(e => VALID_EVENTS.has(e)))
      : null;

    /* 实时订阅 EventBus */
    const listeners: Array<{ eventName: SystemEventName; listener: (payload: SystemEventMap[SystemEventName]) => void }> = [];

    for (const eventName of VALID_EVENTS) {
      if (eventFilter && !eventFilter.has(eventName)) continue;

      const listener = (payload: SystemEventMap[SystemEventName]) => {
        const eventTenantId = (payload as Record<string, unknown>).tenantId as string | undefined;
        if (eventTenantId && eventTenantId !== tenantId) return;
        const seq = bufferEvent(eventName, payload, eventTenantId);
        writeSseEvent(raw, seq, eventName, payload);
      };

      os.bus.on(eventName as SystemEventName, listener);
      listeners.push({ eventName: eventName as SystemEventName, listener });
    }

    /* 心跳 */
    const heartbeat = setInterval(() => {
      writeSseComment(raw, 'keepalive');
    }, config.websocket.heartbeatIntervalMs);

    /* 连接关闭清理。
     *
     * ⚠️ `cleanup` 同时挂在 `close` 与 `error` 上，两者可能**都**触发。
     * 不做幂等就会把计数减两次——多减的那一次会**替别人释放名额**，
     * 使租户可越过 cap（本仓在 Fastify 双钩子上踩过同一个坑，
     * `Math.max(0, …)` 防不住，因为问题不是减到负数而是多减）。 */
    let cleanedUp = false;
    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      sseConnectionCount--;
      const n = sseConnectionsByTenant.get(tenantId) ?? 0;
      if (n <= 1) sseConnectionsByTenant.delete(tenantId);   // 清空即删键，避免租户数无限增长
      else sseConnectionsByTenant.set(tenantId, n - 1);
      clearInterval(heartbeat);
      for (const { eventName, listener } of listeners) {
        os.bus.off(eventName, listener);
      }
      listeners.length = 0;
      if (!raw.writableEnded) raw.end();
    }

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
