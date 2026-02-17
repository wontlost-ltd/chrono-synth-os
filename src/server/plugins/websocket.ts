/**
 * WebSocket 事件流插件
 * 允许客户端订阅系统事件，实时推送变更
 */

import type { FastifyInstance } from 'fastify';
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

  app.get('/ws', { websocket: true }, (socket, _request) => {
    wsConnectionCount++;

    /** 每个连接独立的事件监听器集合 */
    const listeners = new Map<string, (payload: SystemEventMap[SystemEventName]) => void>();

    /** 清理标志：确保 cleanup 只执行一次（error 会触发 close，防止双重清理） */
    let cleaned = false;

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      wsConnectionCount--;
      clearInterval(heartbeat);
      for (const [event, listener] of listeners) {
        os.bus.off(
          event as SystemEventName,
          listener as (payload: SystemEventMap[SystemEventName]) => void,
        );
      }
      listeners.clear();
    }

    safeSend(socket, { type: 'connected' });

    /* 心跳 */
    const heartbeat = setInterval(() => {
      safeSend(socket, { type: 'ping' });
    }, config.websocket.heartbeatIntervalMs);

    socket.on('message', (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      } catch {
        return;
      }

      if (msg.type === 'subscribe' && msg.event && VALID_EVENTS.has(msg.event)) {
        const eventName = msg.event as SystemEventName;
        /* 避免重复订阅 */
        if (!listeners.has(eventName)) {
          const listener = (payload: SystemEventMap[SystemEventName]) => {
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
