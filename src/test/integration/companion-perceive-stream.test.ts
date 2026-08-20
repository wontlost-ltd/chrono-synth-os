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

type Frame = Record<string, unknown>;

/**
 * WS 帧读取器 —— **从连接建立起就持续缓冲**，不漏帧。
 *
 * ⚠️ 旧的 `nextMessage(ws)` 是**位置依赖**的：它假定「下一帧」就是想要的那帧。
 * 中间只要多出任何一帧（迟到的 perceived、蒸馏进度、其它 ack），断言就会读到
 * 错帧——表现为 `undefined !== 'QUOTA_EXCEEDED'` 这种**「值不对」而非「超时」**，
 * 正是 golden 全量跑里观察到的症状。
 *
 * 现在：`createReader(ws)` 在 open 之前就挂好监听并把所有帧存进队列；
 * `next()` 优先从队列取，队列空才等新帧。配合 `waitFor(pred, label, skippable)`
 * 按**内容**匹配，摆脱「第几帧」的假设；失败信息带上已收到的全部帧便于诊断。
 *
 * 注：曾怀疑还有「先 send 后挂监听」的丢帧竞态，写探针实测**不成立**。
 * 原因不是「send 是异步的」，而是 **JS 的 run-to-completion**：message 事件
 * 不会插进正在执行的调用栈，与网络字节何时到达无关。所以只要 send 与
 * addEventListener 在**同一个同步块**里就不会丢（实测 0/30）；只有中间
 * 让出事件循环才会丢（实测 20/20）。本文件所有调用点都是紧挨着的，
 * 不构成该竞态——缓冲式读取器顺带消除了这个隐患，但它不是本次改动的理由。
 */
interface FrameReader {
  /** 取下一帧（已缓冲的优先），不关心内容。 */
  next(timeoutMs?: number): Promise<Frame>;
  /**
   * 等到**满足条件**的帧为止。
   *
   * ⚠️ 中途遇到的帧只有在 `skippable` 里明确列出的类型才允许跳过；
   * 出现协议里不该出现的帧（例如配额拒绝流程中冒出 `perceived`）会**立即失败**。
   * 不能无脑吞掉所有非目标帧——那样等于把协议异常当噪声，断言就废了。
   */
  waitFor(
    pred: (f: Frame) => boolean,
    label: string,
    skippable: readonly string[],
    timeoutMs?: number,
  ): Promise<Frame>;
}

function createReader(ws: WebSocket): FrameReader {
  const buffered: Frame[] = [];
  const all: Frame[] = [];
  /* 等待者用**数组**而不是单个回调：单个回调时若有两处同时在等，
   * 后者会覆盖前者，前者永远不被唤醒、只能等超时。当前用例都是
   * `await` 紧跟、不存在并发等待，但这属于「靠调用方守纪律」的隐患，
   * 用数组从结构上消掉。 */
  const waiters: Array<() => void> = [];

  ws.addEventListener('message', (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    buffered.push(frame);
    all.push(frame);
    /* 全部唤醒；各自重新检查队列。 */
    const pending = waiters.splice(0, waiters.length);
    for (const wake of pending) wake();
  });

  /** 等到队列非空或超时；返回是否还有帧可取。 */
  async function awaitFrame(timeoutMs: number): Promise<boolean> {
    if (buffered.length > 0) return true;
    return await new Promise<boolean>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(wake);
        if (i >= 0) waiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      waiters.push(wake);
    });
  }

  return {
    async next(timeoutMs = 4000): Promise<Frame> {
      if (!(await awaitFrame(timeoutMs))) {
        throw new Error(`WS 消息超时；已收到的帧：${JSON.stringify(all)}`);
      }
      return buffered.shift() as Frame;
    },
    async waitFor(pred, label, skippable, timeoutMs = 4000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (buffered.length > 0) {
          const frame = buffered.shift() as Frame;
          if (pred(frame)) return frame;
          if (!skippable.includes(String(frame.type))) {
            throw new Error(
              `等「${label}」时收到不该出现的帧 ${JSON.stringify(frame)}`
              + `（可跳过的仅 ${skippable.join('/')}）；已收到：${JSON.stringify(all)}`,
            );
          }
        }
        const left = deadline - Date.now();
        if (left <= 0 || !(await awaitFrame(left))) {
          throw new Error(`等不到「${label}」；已收到的帧：${JSON.stringify(all)}`);
        }
      }
    },
  };
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
    const reader = createReader(ws);
    try {
      await open(ws);
      /* 分两片送。 */
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '今天开会很累。' }));
      let m = await reader.next();
      assert.equal(m.type, 'ack');
      assert.equal(m.accumulatedLength, '今天开会很累。'.length);

      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '回家想安静。' }));
      m = await reader.next();
      assert.equal(m.accumulatedLength, '今天开会很累。回家想安静。'.length);

      ws.send(JSON.stringify({ type: 'finalize' }));
      m = await reader.next();
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
    const reader = createReader(ws);
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'finalize' }));
      const m = await reader.next();
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
    const reader = createReader(ws);
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '一些内容' }));
      await reader.next();
      ws.send(JSON.stringify({ type: 'reset' }));
      let m = await reader.next();
      assert.equal(m.type, 'ack');
      assert.equal(m.accumulatedLength, 0);
      ws.send(JSON.stringify({ type: 'finalize' }));
      m = await reader.next();
      assert.equal(m.code, 'EMPTY_FINALIZE', 'reset 后无累积');
    } finally {
      ws.close(); await ctx.app.close(); ctx.os.close();
    }
  });

  it('非法帧 → INVALID_FRAME（不崩连接）', async (t) => {
    const ctx = await setup();
    if (!ctx) { t.skip('sandbox 不允许监听端口'); return; }
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    const reader = createReader(ws);
    try {
      await open(ws);
      ws.send('not json');
      let m = await reader.next();
      assert.equal(m.code, 'INVALID_FRAME');
      /* 连接仍活：发合法 chunk 仍 ack。 */
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '内容' }));
      m = await reader.next();
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
    const reader = createReader(ws);
    try {
      await open(ws);
      /* 累积上限 4000；每片 1000（chunk 上限），第 5 片 1000 会越界（4000+1000>4000）。 */
      const big = 'x'.repeat(1000);
      let last: Record<string, unknown> = {};
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: big }));
        last = await reader.next();
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
    QuotaManager.fromUnitOfWork(ctx.os.getDatabase()).setLimit('default', 'perception', 1, 60_000);
    const ws = new WebSocket(`${ctx.wsUrl}${STREAM}`);
    const reader = createReader(ws);
    try {
      await open(ws);
      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '第一段内容。' }));
      await reader.next();
      ws.send(JSON.stringify({ type: 'finalize' }));
      assert.equal((await reader.next()).type, 'perceived', '第一段成功');

      ws.send(JSON.stringify({ type: 'chunk', modality: 'audio', chunk: '第二段内容。' }));
      await reader.waitFor(f => f.type === 'ack', '第二段 chunk 的 ack', []);
      ws.send(JSON.stringify({ type: 'finalize' }));
      /* 按**内容**等这一帧，而不是假定它恰好是「下一帧」——中间若混入迟到的
       * ack，位置断言就会读到错帧，表现为 `undefined !== 'QUOTA_EXCEEDED'`。
       *
       * 只允许跳过 ack：此处若冒出 `perceived`，说明配额没拦住、真去蒸馏了，
       * 那是必须炸出来的协议异常，不能当噪声跳过。 */
      const quota = await reader.waitFor(
        f => f.type === 'error' && f.code === 'QUOTA_EXCEEDED',
        'QUOTA_EXCEEDED 错误帧',
        ['ack'],
      );
      assert.equal(quota.code, 'QUOTA_EXCEEDED', `第二段应超额，实收：${JSON.stringify(quota)}`);
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
