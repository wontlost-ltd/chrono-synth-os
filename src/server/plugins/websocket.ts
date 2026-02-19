/**
 * WebSocket 事件流插件
 * 允许客户端订阅系统事件，实时推送变更
 * 连接时验证 JWT 认证，绑定租户，仅推送该租户的事件
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { SystemEventName, SystemEventMap } from '../../types/events.js';

/** 所有合法的事件名称集合（运行时校验用） */
const VALID_EVENTS: ReadonlySet<string> = new Set<SystemEventName>([
  'core:value-updated',
  'core:memory-added',
  'core:memory-accessed',
  'core:narrative-changed',
  'core:memory-decayed',
  'core:memory-activated',
  'core:memory-consolidated',
  'core:working-memory-updated',
  'core:survival-updated',
  'core:decision-style-updated',
  'core:cognitive-model-updated',
  'persona:created',
  'persona:status-changed',
  'persona:simulation-completed',
  'meta:conflict-detected',
  'meta:conflict-resolved',
  'meta:resources-allocated',
  'meta:integration-proposed',
  'meta:integration-decided',
  'decision:simulation-progress',
  'decision:simulation-completed',
  'decision:simulation-failed',
  'onboarding:session-started',
  'onboarding:step-completed',
  'onboarding:completed',
  'task:completed',
  'task:failed',
  'life:simulation-progress',
  'life:path-completed',
  'life:simulation-completed',
  'life:simulation-failed',
  'system:snapshot-created',
  'system:snapshot-restored',
  'system:evolution-completed',
  'system:started',
  'system:stopping',
]);

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'pong';
  event?: string;
}

/** 活跃 WebSocket 连接计数 */
let wsConnectionCount = 0;

/** 获取当前活跃 WebSocket 连接数 */
export function getWsConnectionCount(): number {
  return wsConnectionCount;
}

function safeSend(socket: { readyState: number; send: (data: string) => void }, data: unknown): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(data));
  }
}

export async function registerWebSocket(
  app: FastifyInstance,
  os: ChronoSynthOS,
  config: AppConfig,
): Promise<void> {
  if (!config.websocket.enabled) return;

  await app.register(websocketPlugin);

  app.get('/ws', { websocket: true }, (socket, request: FastifyRequest) => {
    /* JWT 鉴权：从已验证的 request.user 获取租户 */
    const user = (request as unknown as { user?: { sub?: string; tenantId?: string } }).user;
    if (config.jwt.enabled && !user?.sub) {
      safeSend(socket, { type: 'error', code: 'AUTH_REQUIRED', message: '需要认证' });
      socket.close(4001, 'Authentication required');
      return;
    }

    const connectionTenantId = user?.tenantId ?? request.tenantId ?? 'default';

    wsConnectionCount++;

    /** 每个连接独立的事件监听器集合 */
    const listeners = new Map<string, (payload: SystemEventMap[SystemEventName]) => void>();

    let cleaned = false;

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      wsConnectionCount--;
      clearInterval(heartbeat);
      clearInterval(rateLimitReset);
      for (const [event, listener] of listeners) {
        os.bus.off(
          event as SystemEventName,
          listener as (payload: SystemEventMap[SystemEventName]) => void,
        );
      }
      listeners.clear();
    }

    safeSend(socket, { type: 'connected', tenantId: connectionTenantId });

    /* 心跳 */
    const heartbeat = setInterval(() => {
      safeSend(socket, { type: 'ping' });
    }, config.websocket.heartbeatIntervalMs);

    /* 消息速率限制：最多 30 条/秒 */
    const WS_MAX_MESSAGES_PER_SECOND = 30;
    const WS_MAX_PAYLOAD_BYTES = 4096;
    let messageCount = 0;
    const rateLimitReset = setInterval(() => { messageCount = 0; }, 1000);

    socket.on('message', (raw: Buffer | string) => {
      const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf-8') : raw.length;

      if (rawBytes > WS_MAX_PAYLOAD_BYTES) {
        safeSend(socket, { type: 'error', code: 'PAYLOAD_TOO_LARGE', message: `消息不得超过 ${WS_MAX_PAYLOAD_BYTES} 字节` });
        return;
      }

      messageCount++;
      if (messageCount > WS_MAX_MESSAGES_PER_SECOND) {
        safeSend(socket, { type: 'error', code: 'RATE_LIMIT', message: '消息速率超限，请等待 1 秒后重试' });
        return;
      }

      const rawStr = typeof raw === 'string' ? raw : raw.toString('utf-8');
      let msg: ClientMessage;
      try {
        msg = JSON.parse(rawStr);
      } catch {
        return;
      }

      if (msg.type === 'subscribe' && msg.event && VALID_EVENTS.has(msg.event)) {
        const eventName = msg.event as SystemEventName;
        if (!listeners.has(eventName)) {
          const listener = (payload: SystemEventMap[SystemEventName]) => {
            /* 租户隔离：仅推送与当前连接租户匹配的事件 */
            const eventTenantId = (payload as Record<string, unknown>).tenantId as string | undefined;
            if (eventTenantId && eventTenantId !== connectionTenantId) return;
            safeSend(socket, { type: 'event', event: eventName, data: payload });
          };
          os.bus.on(eventName, listener as (payload: SystemEventMap[typeof eventName]) => void);
          listeners.set(eventName, listener);
        }
        safeSend(socket, { type: 'subscribed', event: eventName });
      }

      if (msg.type === 'unsubscribe' && msg.event) {
        const eventName = msg.event as SystemEventName;
        const listener = listeners.get(eventName);
        if (listener) {
          os.bus.off(eventName, listener as (payload: SystemEventMap[typeof eventName]) => void);
          listeners.delete(eventName);
        }
        safeSend(socket, { type: 'unsubscribed', event: eventName });
      }

      /* pong 无需处理，仅表示客户端存活 */
    });

    socket.on('error', () => cleanup());
    socket.on('close', () => cleanup());
  });
}
