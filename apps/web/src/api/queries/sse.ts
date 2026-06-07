import { useEffect, useRef } from 'react';
import { API_BASE_URL } from '../../config';
import { getSession } from '../../store/session';
import { getCsrfToken } from '../../lib/csrf';

/**
 * SSE 连接使用 cookie 凭证 + Authorization 头认证，不通过 URL 传递 token，
 * 避免令牌泄露到浏览器历史和服务器日志。
 */
export function useSse<T = unknown>(channel: string, onMessage: (data: T) => void) {
  const callbackRef = useRef(onMessage);
  const lastEventIdRef = useRef<string | null>(null);
  callbackRef.current = onMessage;

  useEffect(() => {
    /* 使用 fetch-based SSE 以支持 credentials 和自定义头 */
    let abortController: AbortController | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;
    /* 初始 1s 重试，指数退避，cap 30s（之前 10s 导致 Cloudflare Tunnel
     * 偶发 502 时持续 polling 噪音 + 占用浏览器并发槽位）。 */
    let reconnectDelayMs = 1000;

    function clearReconnectTimer() {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer !== null) return;
      const delay = reconnectDelayMs;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    }

    async function connect() {
      if (stopped) return;

      abortController?.abort();
      abortController = new AbortController();
      let buffer = '';
      let eventId = '';
      let dataLines: string[] = [];

      const params = new URLSearchParams({ channel });
      if (lastEventIdRef.current) {
        params.set('sinceSeq', lastEventIdRef.current);
      }
      const url = `${API_BASE_URL}/api/v1/events/stream?${params}`;

      function flushEvent() {
        if (dataLines.length === 0) return;
        const raw = dataLines.join('\n').trim();
        if (eventId) lastEventIdRef.current = eventId;
        dataLines = [];
        eventId = '';
        if (!raw) return;
        try {
          callbackRef.current(JSON.parse(raw) as T);
        } catch {
          /* 忽略解析错误 */
        }
      }

      try {
        const session = getSession();
        const headers: Record<string, string> = { 'Accept': 'text/event-stream' };

        /* 通过 header 传递认证信息，避免 token 暴露在 URL 中 */
        if (session.accessToken) {
          headers['Authorization'] = `Bearer ${session.accessToken}`;
        } else if (session.apiKey) {
          headers['X-API-Key'] = session.apiKey;
        }

        const csrf = getCsrfToken();
        if (csrf) headers['X-CSRF-Token'] = csrf;

        const res = await fetch(url, {
          credentials: 'include',
          headers,
          signal: abortController.signal,
        });

        if (!res.ok || !res.body) {
          scheduleReconnect();
          return;
        }

        reconnectDelayMs = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line === '') {
              flushEvent();
              continue;
            }
            if (line.startsWith(':')) continue;
            if (line.startsWith('id:')) {
              eventId = line.slice(3).trim();
              continue;
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
        flushEvent();
        scheduleReconnect();
      } catch {
        if (stopped || abortController.signal.aborted) return;
        scheduleReconnect();
      }
    }

    void connect();
    return () => {
      stopped = true;
      clearReconnectTimer();
      abortController?.abort();
    };
  }, [channel]);
}
