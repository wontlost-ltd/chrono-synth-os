import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

/** 等待指定时间 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 WebSocket 读取下一条 JSON 消息（带超时） */
function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 消息超时')), timeoutMs);
    const handler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
      resolve(JSON.parse(String(event.data)));
    };
    ws.addEventListener('message', handler);
  });
}

describe('WebSocket 事件流', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let baseUrl: string;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: true, heartbeatIntervalMs: 60_000 },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
    const address = await app.listen({ port: 0 });
    baseUrl = address.replace('http:', 'ws:');
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('连接后收到 connected 消息', async () => {
    const ws = new WebSocket(`${baseUrl}/ws`);
    try {
      const msg = await nextMessage(ws);
      assert.equal(msg.type, 'connected');
    } finally {
      ws.close();
    }
  });

  it('订阅事件后收到 subscribed 确认', async () => {
    const ws = new WebSocket(`${baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      const msg = await nextMessage(ws);
      assert.equal(msg.type, 'subscribed');
      assert.equal(msg.event, 'core:value-updated');
    } finally {
      ws.close();
    }
  });

  it('订阅后收到对应事件推送', async () => {
    const ws = new WebSocket(`${baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      await nextMessage(ws);

      /* 触发事件 */
      os.core.addValue('勇气', 0.7);

      const msg = await nextMessage(ws);
      assert.equal(msg.type, 'event');
      assert.equal(msg.event, 'core:value-updated');
      assert.ok(msg.data);
    } finally {
      ws.close();
    }
  });

  it('取消订阅后不再收到事件', async () => {
    const ws = new WebSocket(`${baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      await nextMessage(ws);

      ws.send(JSON.stringify({ type: 'unsubscribe', event: 'core:value-updated' }));
      const unsub = await nextMessage(ws);
      assert.equal(unsub.type, 'unsubscribed');

      /* 触发事件 — 不应收到推送 */
      os.core.addValue('诚实', 0.9);

      /* 确认在 300ms 内没有收到任何消息 */
      const received: Record<string, unknown>[] = [];
      const handler = (event: MessageEvent) => {
        received.push(JSON.parse(String(event.data)));
      };
      ws.addEventListener('message', handler);
      await delay(300);
      ws.removeEventListener('message', handler);

      const events = received.filter(m => m.type === 'event');
      assert.equal(events.length, 0, '取消订阅后不应收到事件');
    } finally {
      ws.close();
    }
  });

  it('断开连接后清理所有监听器', async () => {
    const ws = new WebSocket(`${baseUrl}/ws`);
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
    await nextMessage(ws);

    /* 记录断开前的监听器数量 */
    const before = os.bus.listenerCount('core:value-updated');

    ws.close();
    /* 等待 close 事件传播 */
    await delay(200);

    const after = os.bus.listenerCount('core:value-updated');
    assert.equal(after, before - 1);
  });
});
