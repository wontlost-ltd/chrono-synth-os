import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

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

interface WebSocketTestContext {
  os: ChronoSynthOS;
  app: FastifyInstance;
  baseUrl: string;
}

const config = loadConfig({
  rateLimit: { max: 10000, timeWindowMs: 60_000 },
  websocket: { enabled: true, heartbeatIntervalMs: 60_000 },
});

async function setupContext(): Promise<WebSocketTestContext | null> {
  const clock = new TestClock(1000);
  const logger = new SilentLogger();
  const os = new ChronoSynthOS({ clock, logger });
  os.start();
  const app = await createApp({ os, config });

  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    return {
      os,
      app,
      baseUrl: address.replace('http:', 'ws:'),
    };
  } catch (err) {
    await app.close();
    os.close();
    if (isSocketPermissionError(err)) {
      return null;
    }
    throw err;
  }
}

async function teardownContext(context: WebSocketTestContext): Promise<void> {
  await context.app.close();
  context.os.close();
}

function isSocketPermissionError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'EPERM',
  );
}

describe('WebSocket 事件流', () => {
  it('连接后收到 connected 消息', async (t) => {
    const context = await setupContext();
    if (!context) {
      t.skip('sandbox 不允许监听测试端口');
      return;
    }

    const ws = new WebSocket(`${context.baseUrl}/ws`);
    try {
      const msg = await nextMessage(ws);
      assert.equal(msg.type, 'connected');
    } finally {
      ws.close();
      await teardownContext(context);
    }
  });

  it('订阅事件后收到 subscribed 确认', async (t) => {
    const context = await setupContext();
    if (!context) {
      t.skip('sandbox 不允许监听测试端口');
      return;
    }

    const ws = new WebSocket(`${context.baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      const msg = await nextMessage(ws);
      assert.equal(msg.type, 'subscribed');
      assert.equal(msg.event, 'core:value-updated');
    } finally {
      ws.close();
      await teardownContext(context);
    }
  });

  it('订阅后收到对应事件推送', async (t) => {
    const context = await setupContext();
    if (!context) {
      t.skip('sandbox 不允许监听测试端口');
      return;
    }

    const ws = new WebSocket(`${context.baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      await nextMessage(ws);

      context.os.core.addValue('勇气', 0.7);

      const msg = await nextMessage(ws);
      assert.equal(msg.type, 'event');
      assert.equal(msg.event, 'core:value-updated');
      assert.ok(msg.data);
    } finally {
      ws.close();
      await teardownContext(context);
    }
  });

  it('取消订阅后不再收到事件', async (t) => {
    const context = await setupContext();
    if (!context) {
      t.skip('sandbox 不允许监听测试端口');
      return;
    }

    const ws = new WebSocket(`${context.baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      await nextMessage(ws);

      ws.send(JSON.stringify({ type: 'unsubscribe', event: 'core:value-updated' }));
      const unsub = await nextMessage(ws);
      assert.equal(unsub.type, 'unsubscribed');

      context.os.core.addValue('诚实', 0.9);

      const received: Record<string, unknown>[] = [];
      const handler = (event: MessageEvent) => {
        received.push(JSON.parse(String(event.data)));
      };
      ws.addEventListener('message', handler);
      await delay(300);
      ws.removeEventListener('message', handler);

      const events = received.filter((message) => message.type === 'event');
      assert.equal(events.length, 0, '取消订阅后不应收到事件');
    } finally {
      ws.close();
      await teardownContext(context);
    }
  });

  it('断开连接后清理所有监听器', async (t) => {
    const context = await setupContext();
    if (!context) {
      t.skip('sandbox 不允许监听测试端口');
      return;
    }

    const ws = new WebSocket(`${context.baseUrl}/ws`);
    try {
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', event: 'core:value-updated' }));
      await nextMessage(ws);

      const before = context.os.bus.listenerCount('core:value-updated');

      ws.close();
      await delay(200);

      const after = context.os.bus.listenerCount('core:value-updated');
      assert.equal(after, before - 1);
    } finally {
      ws.close();
      await teardownContext(context);
    }
  });
});
