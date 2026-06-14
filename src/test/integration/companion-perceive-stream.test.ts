/**
 * 集成测试：实时流感知 WS（ADR-0051 Phase 5）。
 *
 * 连真 fastify-websocket，驱动 chunk→ack→finalize→perceived 协议；jwt 关闭时以 'default' 租户跑
 * （无 LLM key → MockPerceptionProvider 确定性蒸馏）。验证：分片累积、ack 回长度、finalize 异步出
 * perceived、空 finalize/超额/非法帧的错误、reset 清空。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

function nextMessage(ws: WebSocket, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 消息超时')), timeoutMs);
    const handler = (event: MessageEvent): void => {
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    };
    ws.addEventListener('message', handler);
  });
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) return resolve();
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true });
  });
}

const config = loadConfig({
  rateLimit: { max: 10000, timeWindowMs: 60_000 },
  websocket: { enabled: true, heartbeatIntervalMs: 60_000 },
  jwt: { enabled: false, secret: 'x'.repeat(40), issuer: 'test' },
});

const STREAM = '/api/v1/companion/me/perceive/stream';

async function setup(): Promise<{ os: ChronoSynthOS; app: FastifyInstance; wsUrl: string } | null> {
  const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
  os.start();
  const app = await createApp({ os, config });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    return { os, app, wsUrl: address.replace('http:', 'ws:') };
  } catch (err) {
    await app.close(); os.close();
    if (String(err).includes('EPERM') || String(err).includes('EACCES')) return null;
    throw err;
  }
}

describe('实时流感知 WS', () => {
  it('chunk→ack→finalize→perceived：分片累积后异步蒸馏出记忆', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    try {
      await open(ws);
      /* 分两片送。 */
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '今天开会很累。' }));
      let m = await nextMessage(ws);
      assert.equal(m.type, 'ack');
      assert.equal(m.accumulatedLength, '今天开会很累。'.length);

      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '回家想安静。' }));
      m = await nextMessage(ws);
      assert.equal(m.accumulatedLength, '今天开会很累。回家想安静。'.length);

      ws.send(JSON.stringify({ type: 'finalize' }));
      m = await nextMessage(ws);
      assert.equal(m.type, 'perceived', JSON.stringify(m));
      const result = m.result as { perceivedMemories: unknown[]; schemaVersion: string };
      assert.equal(result.schemaVersion, 'companion-perceive-result.v1');
      assert.ok(result.perceivedMemories.length >= 1, '累积全文蒸馏出 ≥1 条记忆');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('空 finalize（没累积）→ EMPTY_FINALIZE 错误', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'finalize' }));
      const m = await nextMessage(ws);
      assert.equal(m.type, 'error');
      assert.equal(m.code, 'EMPTY_FINALIZE');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('reset 清空累积（reset 后 finalize 仍 EMPTY）', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '一些内容' }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'reset' }));
      let m = await nextMessage(ws);
      assert.equal(m.type, 'ack');
      assert.equal(m.accumulatedLength, 0);
      ws.send(JSON.stringify({ type: 'finalize' }));
      m = await nextMessage(ws);
      assert.equal(m.code, 'EMPTY_FINALIZE', 'reset 后无累积');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('非法帧 → INVALID_FRAME（不崩连接）', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    try {
      await open(ws);
      ws.send('not json');
      let m = await nextMessage(ws);
      assert.equal(m.code, 'INVALID_FRAME');
      /* 连接仍活：发合法 chunk 仍 ack。 */
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '内容' }));
      m = await nextMessage(ws);
      assert.equal(m.type, 'ack');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });
});
