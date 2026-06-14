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

  it('消息速率超限 → RATE_LIMIT（防高频刷帧 DoS）', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    /* 收集所有响应（避免 nextMessage 逐条监听漏帧）。 */
    const codes: string[] = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { code?: string };
      if (m.code) codes.push(m.code);
    });
    try {
      await open(ws);
      /* 一秒内猛发 40 条非法帧（>30/s 上限）→ 必有 RATE_LIMIT。 */
      for (let i = 0; i < 40; i++) ws.send('bad');
      /* 等响应落齐。 */
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(codes.includes('RATE_LIMIT'), `高频帧应触发 RATE_LIMIT（收到 ${codes.length} 条响应）`);
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('累积超上限 → BUFFER_FULL', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    try {
      await open(ws);
      /* 累积上限 4000；每片 1000（chunk 上限），第 5 片 1000 会越界（4000+1000>4000）。 */
      const big = 'x'.repeat(1000);
      let last: Record<string, unknown> = {};
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: big }));
        last = await nextMessage(ws);
      }
      assert.equal(last.code, 'BUFFER_FULL', '第 5 片越界 4000 上限');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('配额用尽 → finalize 回 QUOTA_EXCEEDED（在异步蒸馏前扣，防刷）', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    /* 设 perception 限额 1：第一段 finalize 用掉，第二段 finalize 超额。 */
    const { QuotaManager } = await import('../../multi-tenant/quota-manager.js');
    new QuotaManager(ctx.os.getDatabase()).setLimit('default', 'perception', 1, 60_000);
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '第一段内容。' }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'finalize' }));
      assert.equal((await nextMessage(ws)).type, 'perceived', '第一段成功');

      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '第二段内容。' }));
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: 'finalize' }));
      assert.equal((await nextMessage(ws)).code, 'QUOTA_EXCEEDED', '第二段超额');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('并发 finalize：蒸馏进行中第二个 finalize → BUSY（不重复蒸馏）', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    /* 收集所有响应码（两个 finalize 背靠背，抓 perceived + BUSY）。 */
    const frames: Array<{ type?: string; code?: string }> = [];
    ws.addEventListener('message', (e) => { frames.push(JSON.parse(String(e.data)) as { type?: string; code?: string }); });
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '一段内容。' }));
      /* 背靠背两个 finalize：第一个进异步蒸馏（distilling=true），第二个同一 tick 内到达 → BUSY。 */
      ws.send(JSON.stringify({ type: 'finalize' }));
      ws.send(JSON.stringify({ type: 'finalize' }));
      await new Promise((r) => setTimeout(r, 800));
      const busy = frames.some((f) => f.code === 'BUSY');
      const perceived = frames.some((f) => f.type === 'perceived');
      assert.ok(perceived, '第一个 finalize 出 perceived');
      assert.ok(busy, '蒸馏中的第二个 finalize → BUSY');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });
});
