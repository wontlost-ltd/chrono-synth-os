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

/** 进程唯一标识（防止自己收到自己发布的事件） */
const processId = crypto.randomUUID();

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

/** 最近事件环形缓冲区（用于断线重连重放） */
const EVENT_BUFFER_SIZE = 256;
interface BufferedEvent {
  seq: number;
  event: string;
  data: unknown;
  tenantId?: string;
}
const recentEvents: BufferedEvent[] = [];
let recentEventsWriteIdx = 0;
let recentEventsFilled = false;

/** 全局递增事件序列号 */
let globalSeq = 0;

/** 持久化事件日志的 DB 引用（由 registerWebSocket 设置） */
let eventLogDb: import('../../storage/database.js').IDatabase | undefined;

/** 事件日志保留窗口（运行时由 config.websocket.eventLogRetentionMs 覆盖） */
let EVENT_LOG_TTL_MS = 60 * 60 * 1000;
/** 断线重连重放最大事件数（运行时由 config.websocket.replayLimit 覆盖） */
let REPLAY_LIMIT = 1000;

/** 缓存一个事件到环形缓冲区并持久化到 DB（seq 由 DB 生成，多副本安全） */
function bufferEvent(event: string, data: unknown, tenantId?: string): number {
  let seq: number;
  const payload = JSON.stringify(data);
  const now = Date.now();

  /* 优先由 DB AUTOINCREMENT/BIGSERIAL 生成 seq（多副本安全） */
  if (eventLogDb) {
    try {
      /* RETURNING seq 适用于 PG 和 SQLite >= 3.35 */
      const row = eventLogDb.prepare<{ seq: number }>(
        'INSERT INTO ws_event_log (event, data_json, tenant_id, created_at) VALUES (?, ?, ?, ?) RETURNING seq',
      ).get(event, payload, tenantId ?? null, now);
      seq = row?.seq ?? 0;
      if (!seq) throw new Error('no seq returned');
    } catch {
      /* 回退：旧版 SQLite 不支持 RETURNING，使用 lastInsertRowid */
      try {
        const result = eventLogDb.prepare<void>(
          'INSERT INTO ws_event_log (event, data_json, tenant_id, created_at) VALUES (?, ?, ?, ?)',
        ).run(event, payload, tenantId ?? null, now);
        seq = Number(result.lastInsertRowid) || ++globalSeq;
      } catch {
        seq = ++globalSeq;
      }
    }
  } else {
    seq = ++globalSeq;
  }

  if (seq > globalSeq) globalSeq = seq;

  const entry: BufferedEvent = { seq, event, data, tenantId };
  if (recentEvents.length < EVENT_BUFFER_SIZE) {
    recentEvents.push(entry);
  } else {
    recentEvents[recentEventsWriteIdx] = entry;
  }
  recentEventsWriteIdx = (recentEventsWriteIdx + 1) % EVENT_BUFFER_SIZE;
  if (recentEventsWriteIdx === 0 && recentEvents.length >= EVENT_BUFFER_SIZE) recentEventsFilled = true;

  return seq;
}

/** 从持久化事件日志恢复（当内存缓冲区不足时回退） */
function getPersistedEventsSince(sinceSeq: number, tenantId: string): BufferedEvent[] {
  if (!eventLogDb) return [];
  try {
    const rows = eventLogDb.prepare<{ seq: number; event: string; data_json: string; tenant_id: string | null }>(
      `SELECT seq, event, data_json, tenant_id FROM ws_event_log WHERE seq > ? AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY seq ASC LIMIT ${REPLAY_LIMIT}`,
    ).all(sinceSeq, tenantId);
    return rows.map(r => ({
      seq: r.seq,
      event: r.event,
      data: JSON.parse(r.data_json),
      tenantId: r.tenant_id ?? undefined,
    }));
  } catch { return []; }
}

/** 清理过期事件日志 */
function pruneEventLog(): void {
  if (!eventLogDb) return;
  try {
    eventLogDb.prepare<void>('DELETE FROM ws_event_log WHERE created_at < ?').run(Date.now() - EVENT_LOG_TTL_MS);
  } catch { /* 清理失败不影响服务 */ }
}

/** 获取缓冲区中最旧的序列号 */
function getOldestBufferedSeq(): number | null {
  if (recentEvents.length === 0) return null;
  if (!recentEventsFilled) return recentEvents[0].seq;
  return recentEvents[recentEventsWriteIdx].seq;
}

/** 获取 sinceSeq 之后的缓冲事件 */
function getBufferedEventsSince(sinceSeq: number, tenantId: string): BufferedEvent[] {
  const result: BufferedEvent[] = [];
  const len = recentEventsFilled ? EVENT_BUFFER_SIZE : recentEvents.length;
  for (let i = 0; i < len; i++) {
    const entry = recentEvents[i];
    if (entry.seq > sinceSeq) {
      if (!entry.tenantId || entry.tenantId === tenantId) {
        result.push(entry);
      }
    }
  }
  return result.sort((a, b) => a.seq - b.seq);
}

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'pong' | 'replay';
  event?: string;
  sinceSeq?: number;
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

const REDIS_EVENT_CHANNEL = 'chrono:events';

export async function registerWebSocket(
  app: FastifyInstance,
  os: ChronoSynthOS,
  config: AppConfig,
): Promise<void> {
  if (!config.websocket.enabled) return;

  /* 应用可配置参数 */
  EVENT_LOG_TTL_MS = config.websocket.eventLogRetentionMs;
  REPLAY_LIMIT = config.websocket.replayLimit;

  /* 初始化持久化事件日志 */
  try {
    eventLogDb = os.getDatabase();
    /* 启动时恢复 globalSeq（从持久化日志中读取最大序列号） */
    const maxSeqRow = eventLogDb.prepare<{ max_seq: number | null }>('SELECT MAX(seq) as max_seq FROM ws_event_log').get();
    if (maxSeqRow?.max_seq && maxSeqRow.max_seq > globalSeq) globalSeq = maxSeqRow.max_seq;
  } catch { eventLogDb = undefined; }

  /* 定期清理过期事件日志（每 10 分钟） */
  const pruneInterval = setInterval(pruneEventLog, 10 * 60 * 1000);
  app.addHook('onClose', async () => { clearInterval(pruneInterval); });

  await app.register(websocketPlugin);

  /* Redis 事件背板：跨副本事件传播 */
  let redisPub: typeof app.redis | undefined;
  let redisSub: typeof app.redis | undefined;
  if (app.redis) {
    redisPub = app.redis;
    redisSub = app.redis.duplicate();
    await redisSub.subscribe(REDIS_EVENT_CHANNEL);
    redisSub.on('message', (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as { event?: string; payload?: unknown; origin?: string };
        if (!parsed.event || !parsed.origin || parsed.origin === processId) return;
        if (!VALID_EVENTS.has(parsed.event)) return;
        os.bus.emit(parsed.event as SystemEventName, parsed.payload as SystemEventMap[SystemEventName]);
      } catch { /* 忽略格式错误的消息 */ }
    });

    /* 本地事件发布到 Redis */
    for (const eventName of VALID_EVENTS) {
      os.bus.on(eventName as SystemEventName, (payload) => {
        redisPub?.publish(REDIS_EVENT_CHANNEL, JSON.stringify({
          event: eventName,
          payload,
          origin: processId,
        })).catch(() => { /* 发布失败不阻塞 */ });
      });
    }

    app.addHook('onClose', async () => {
      if (redisSub) {
        await redisSub.unsubscribe(REDIS_EVENT_CHANNEL).catch(() => {});
        redisSub.disconnect();
      }
    });
  }

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
            const seq = bufferEvent(eventName, payload, eventTenantId);
            safeSend(socket, { type: 'event', event: eventName, data: payload, seq });
          };
          os.bus.on(eventName, listener as (payload: SystemEventMap[typeof eventName]) => void);
          listeners.set(eventName, listener);
        }
        safeSend(socket, { type: 'subscribed', event: eventName });
      }

      if (msg.type === 'replay' && typeof msg.sinceSeq === 'number') {
        const oldestSeq = getOldestBufferedSeq();
        let replayFrom = msg.sinceSeq;
        let missed: BufferedEvent[];

        if (replayFrom > globalSeq) {
          /* 客户端序列号超前（可能连接到不同副本）*/
          safeSend(socket, { type: 'replay-gap', oldestSeq: oldestSeq ?? 0, lastSeq: globalSeq });
          replayFrom = globalSeq;
          missed = [];
        } else if (oldestSeq !== null && replayFrom < oldestSeq) {
          /* 内存缓冲区不足，尝试从持久化日志恢复 */
          missed = getPersistedEventsSince(replayFrom, connectionTenantId);
          if (missed.length === 0) {
            safeSend(socket, { type: 'replay-gap', oldestSeq, lastSeq: globalSeq });
          }
        } else {
          missed = getBufferedEventsSince(replayFrom, connectionTenantId);
        }

        for (const entry of missed) {
          safeSend(socket, { type: 'event', event: entry.event, data: entry.data, seq: entry.seq });
        }
        safeSend(socket, { type: 'replay-complete', lastSeq: globalSeq, replayedCount: missed.length });
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
