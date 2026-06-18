import { useEffect, useRef } from 'react';
import { getSession, tryRefresh } from './auth.js';
import { decide401Action } from './api-retry.js';

/**
 * SSE 流式行解析器（纯函数，可测）：喂入解码后的 chunk，吐出**完整事件数**（空行分隔）。
 * 只关心「来了几条事件」——nudge-created 内容无需解析（只作刷新触发）。
 * 维护跨 chunk 的残余 buffer + 当前事件是否有 data 行。
 */
export class SseEventCounter {
  private buffer = '';
  private hasData = false;

  /** 喂一个 chunk，返回本次新完成的事件数。 */
  push(chunk: string): number {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    let events = 0;
    for (const line of lines) {
      if (line === '') {
        if (this.hasData) { events++; this.hasData = false; }
        continue;
      }
      if (line.startsWith(':') || line.startsWith('id:')) continue;
      if (line.startsWith('data:')) this.hasData = true;
    }
    return events;
  }

  /** 流结束时 flush 最后一个未以空行收尾的事件（含残余 buffer 里未换行的 data 行）。 */
  flush(): number {
    /* 残余 buffer 可能是一条没有尾随换行的 data 行（如 'data: x'）。 */
    if (this.buffer.startsWith('data:')) this.hasData = true;
    this.buffer = '';
    if (this.hasData) { this.hasData = false; return 1; }
    return 0;
  }
}

/**
 * 订阅 companion:nudge-created SSE 事件（ADR-0054 Phase 6 in-app push 实时刷新）。
 *
 * 用 **fetch-based SSE**（非原生 EventSource）——companion 把 accessToken 放内存经
 * `Authorization: Bearer` 发送（不落 localStorage 降 XSS 面），而原生 EventSource 无法带自定义头，
 * 只能把 token 塞 URL（会泄露到日志/历史）。fetch + getReader 既能带 Bearer 又不暴露 token。
 * 与 apps/web 的 useSse 同源思路。
 *
 * 只订阅 nudge-created 单事件（?events= 白名单过滤），收到即调 onNudge 触发列表刷新。
 * 断线指数退避重连（1s→cap 30s）。卸载/无会话时停止。
 */
export function useNudgeStream(onNudge: () => void): void {
  const cbRef = useRef(onNudge);
  cbRef.current = onNudge;

  useEffect(() => {
    let abort: AbortController | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;
    let delayMs = 1000;

    function scheduleReconnect(): void {
      if (stopped || reconnectTimer !== null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
    }

    /* 单个 connect 周期内是否已尝试过一次 401 refresh——防「刷新成功但 SSE 仍 401」的紧循环。 */
    async function connect(refreshedThisCycle = false): Promise<void> {
      if (stopped) return;
      const session = getSession();
      if (!session) return; /* 未登录不连 */
      const sentToken = session.accessToken;

      abort?.abort();
      abort = new AbortController();
      const counter = new SseEventCounter();

      /* 收到 N 条 nudge-created → 触发一次刷新即可（合并同批，避免连环重取）。 */
      function fire(n: number): void { if (n > 0) cbRef.current(); }

      try {
        const res = await fetch('/api/v1/events/stream?events=companion:nudge-created', {
          method: 'GET',
          credentials: 'include',
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${sentToken}`,
            'x-tenant-id': session.tenantId,
          },
          signal: abort.signal,
        });
        /* 401：复用 api.ts 同款 decide401Action——会话已被并发 login/logout 换掉则用当前会话重试
         * （绝不 refresh/清新会话）；否则才 refresh。刷新成功重连一次；本周期已 refresh 过仍 401 → 退避
         * （防紧循环）。失败 → 停止（auth 已清会话，等重登）。token 过期后实时刷新能恢复（Codex 退回 High）。 */
        if (res.status === 401) {
          if (stopped) return;
          const action = decide401Action(sentToken, getSession()?.accessToken ?? null);
          if (action === 'retry-current') { void connect(refreshedThisCycle); return; }
          if (refreshedThisCycle) { scheduleReconnect(); return; } /* 已刷新过仍 401 → 退避，不紧循环 */
          const outcome = await tryRefresh();
          if (stopped) return;
          if (outcome === 'refreshed' || outcome === 'superseded') { void connect(true); }
          else { stopped = true; } /* 刷新失败 → 停止重连 */
          return;
        }
        if (!res.ok || !res.body) { scheduleReconnect(); return; }
        delayMs = 1000; /* 连上即重置退避 */
        /* 连接成功 → 补拉一次：覆盖断线窗口内产生的 nudge（事件无回放，重连后主动刷新一次）。 */
        cbRef.current();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          fire(counter.push(decoder.decode(value, { stream: true })));
        }
        fire(counter.flush());
        scheduleReconnect();
      } catch {
        if (stopped || abort.signal.aborted) return;
        scheduleReconnect();
      }
    }

    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      abort?.abort();
    };
  }, []);
}
