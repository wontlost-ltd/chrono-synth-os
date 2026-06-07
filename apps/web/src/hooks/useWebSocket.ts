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
      if (attemptsRef.current < maxReconnectAttempts) {
        /* 指数退避 + 随机抖动：避免多客户端同时重连造成惊群效应 */
        const base = Math.min(reconnectInterval * Math.pow(2, attemptsRef.current), maxReconnectInterval);
        const jitter = base * 0.3 * Math.random();
        const delay = base + jitter;
        attemptsRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      } else {
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
    attemptsRef.current = maxReconnectAttempts;
    wsRef.current?.close();
  }, [maxReconnectAttempts]);

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
    if (autoConnect) connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      attemptsRef.current = maxReconnectAttempts;
      wsRef.current?.close();
    };
  }, [autoConnect, connect, maxReconnectAttempts]);

  return { status, lastEvent, connect, disconnect, subscribe, send, wsError };
}
