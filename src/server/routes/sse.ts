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

/** SSE 活跃连接计数 */
let sseConnectionCount = 0;
export function getSseConnectionCount(): number { return sseConnectionCount; }

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

    /* SSE 连接数限制 */
    const maxConns = config.sse?.maxConnectionsPerTenant ?? 50;
    if (sseConnectionCount >= maxConns * 10) {
      return reply.code(503).send({ error: 'SSE 连接数已达上限' });
    }

    sseConnectionCount++;

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

    /* 连接关闭清理 */
    function cleanup(): void {
      sseConnectionCount--;
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
