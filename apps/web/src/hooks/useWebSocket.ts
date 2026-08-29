import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface WsEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

interface UseWebSocketOptions {
  url?: string;
  autoConnect?: boolean;
  /** 初始重连间隔（毫秒），默认 1000 */
  reconnectInterval?: number;
  /** 最大重连间隔（毫秒），默认 30000 */
  maxReconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    autoConnect = true,
    reconnectInterval = 1000,
    maxReconnectInterval = 30000,
    maxReconnectAttempts = 10,
  } = options;

  const { t } = useTranslation();
  const wsRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  /* ⚠️ 审计 #415：「已拆卸/已主动断开」必须用**独立标记**，不能借用重试计数器。
   * 此前 cleanup 与 disconnect 都写 `attemptsRef.current = maxReconnectAttempts`
   * 来表达「别再重连了」—— 但该值**跨 effect 重跑存活**（useRef 不随 effect 重置），
   * 而 attemptsRef 只在 `ws.onopen` 归零。于是 effect 重跑后若首次连接没能 open，
   * onclose 看到 `attempts >= max` ⇒ **0 次重试**直接放弃。
   *
   * 生产触发点：`Dashboard.tsx:41` 是 `useWebSocket({ autoConnect: !!simId })`，
   * simId 随用户选择/取消模拟切换 —— 从模拟面板回总览再打开，恰逢后端短暂重启，
   * 就会立刻显示「重连失败，已达最大尝试次数 (10)」（实际只试了 1 次），
   * 此后**必须整页刷新**才能恢复。 */
  const disposedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listenersRef = useRef(new Map<string, Set<(payload: unknown) => void>>());
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setStatus('connecting');
    setWsError(null);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      setWsError(null);
      attemptsRef.current = 0;
      // 重连后重新订阅所有事件
      for (const eventType of listenersRef.current.keys()) {
        ws.send(JSON.stringify({ action: 'subscribe', event: eventType }));
      }
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as WsEvent;
        setLastEvent(data);
        const handlers = listenersRef.current.get(data.type);
        if (handlers) {
          for (const fn of handlers) fn(data.payload);
        }
      } catch { /* non-JSON message ignored */ }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      wsRef.current = null;
      if (!disposedRef.current && attemptsRef.current < maxReconnectAttempts) {
        /* 指数退避 + 随机抖动：避免多客户端同时重连造成惊群效应 */
        const base = Math.min(reconnectInterval * Math.pow(2, attemptsRef.current), maxReconnectInterval);
        const jitter = base * 0.3 * Math.random();
        const delay = base + jitter;
        attemptsRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      } else if (!disposedRef.current) {
        /* 只有「真的重试到上限」才报错；主动断开/组件拆卸属正常路径，不打扰用户。 */
        setWsError(t('errors.wsReconnectFailed', { max: maxReconnectAttempts }));
      }
    };

    ws.onerror = () => {
      setWsError(t('errors.wsConnectionError'));
      ws.close();
    };
  }, [url, reconnectInterval, maxReconnectInterval, maxReconnectAttempts, t]);

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimerRef.current);
    disposedRef.current = true;
    wsRef.current?.close();
  }, []);

  const subscribe = useCallback((eventType: string, handler: (payload: unknown) => void) => {
    if (!listenersRef.current.has(eventType)) {
      listenersRef.current.set(eventType, new Set());
    }
    listenersRef.current.get(eventType)!.add(handler);

    // Send subscription message to server
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'subscribe', event: eventType }));
    }

    return () => {
      listenersRef.current.get(eventType)?.delete(handler);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'unsubscribe', event: eventType }));
      }
    };
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    /* ⚠️ 只在**挂载/重新启用**时重置，不能放进 connect() —— 重试链上的每次
     * 重连都会调 connect()，在那里清标记会让「已断开」被自己的重试撤销，
     * 退避永远从头开始 ⇒ 无限重连（实测实例数不收敛：18 → 24）。 */
    disposedRef.current = false;
    attemptsRef.current = 0;
    if (autoConnect) connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      disposedRef.current = true;
      wsRef.current?.close();
    };
  }, [autoConnect, connect]);

  return { status, lastEvent, connect, disconnect, subscribe, send, wsError };
}
