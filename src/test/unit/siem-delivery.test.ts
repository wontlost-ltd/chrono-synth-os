/**
 * P1-Q-3 — SIEM delivery tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SiemDelivery, DEFAULT_SIEM_OPTIONS, type SiemTransport } from '../../siem/siem-delivery.js';

class StubTransport implements SiemTransport {
  delivered: string[] = [];
  mode: 'ok' | 'transient' | 'permanent' | 'throw' = 'ok';
  async deliver(payload: string): Promise<{ ok: true } | { ok: false; permanent: boolean; reason: string }> {
    if (this.mode === 'throw') throw new Error('transport-down');
    if (this.mode === 'transient') return { ok: false, permanent: false, reason: '5xx upstream' };
    if (this.mode === 'permanent') return { ok: false, permanent: true, reason: '4xx schema invalid' };
    this.delivered.push(payload);
    return { ok: true };
  }
}

describe('SiemDelivery — happy path', () => {
  it('drains buffer on flush() when transport returns ok', async () => {
    const t = new StubTransport();
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0 });
    s.enqueue('e1'); s.enqueue('e2'); s.enqueue('e3');
    await s.flush();
    assert.deepEqual(t.delivered, ['e1', 'e2', 'e3']);
    const snap = s.snapshot();
    assert.equal(snap.pending, 0);
    assert.equal(snap.delivered, 3);
  });
});

describe('SiemDelivery — transient failure', () => {
  it('keeps event in buffer + bumps retries', async () => {
    const t = new StubTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 3 });
    s.enqueue('e1');
    await s.flush();
    /* After 1st transient, event still pending (just retried once),
     * flush returned because we preserve order. */
    assert.equal(s.snapshot().pending, 1);
    assert.equal(s.snapshot().transientFailures, 1);
  });

  it('moves to dead-letter after maxRetries', async () => {
    const t = new StubTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 2 });
    s.enqueue('e-bad');
    await s.flush(); await s.flush(); /* 2 attempts triggers DLQ move */
    const snap = s.snapshot();
    assert.equal(snap.pending, 0);
    assert.equal(snap.deadLettered, 1);
    assert.equal(snap.transientFailures, 2);
  });

  it('after dead-lettering, subsequent events still flow', async () => {
    const t = new StubTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 1 });
    s.enqueue('poison');
    await s.flush();
    /* poison moved to DLQ */
    t.mode = 'ok';
    s.enqueue('after');
    await s.flush();
    assert.deepEqual(t.delivered, ['after']);
    assert.equal(s.snapshot().deadLettered, 1);
  });
});

describe('SiemDelivery — permanent failure (4xx)', () => {
  it('moves event to dead-letter immediately without retries', async () => {
    const t = new StubTransport();
    t.mode = 'permanent';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0 });
    s.enqueue('schema-invalid');
    await s.flush();
    const snap = s.snapshot();
    assert.equal(snap.deadLettered, 1);
    assert.equal(snap.permanentFailures, 1);
    /* transientFailures unchanged */
    assert.equal(snap.transientFailures, 0);
  });
});

describe('SiemDelivery — transport throws', () => {
  it('treats as transient', async () => {
    const t = new StubTransport();
    t.mode = 'throw';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 5 });
    s.enqueue('e');
    await s.flush();
    /* Still pending; transient failure recorded */
    assert.equal(s.snapshot().pending, 1);
    assert.equal(s.snapshot().transientFailures, 1);
  });
});

describe('SiemDelivery — overflow', () => {
  it('evicts oldest from buffer to dead-letter when full', () => {
    const t = new StubTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxBufferSize: 3 });
    s.enqueue('a'); s.enqueue('b'); s.enqueue('c');
    s.enqueue('d'); /* triggers eviction of 'a' to DLQ */
    assert.equal(s.snapshot().pending, 3);
    assert.equal(s.snapshot().deadLettered, 1);
  });

  it('counts overflowDrops when both buffer and DLQ full', () => {
    const t = new StubTransport();
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxBufferSize: 1, maxDeadLetterSize: 1 });
    s.enqueue('a'); /* buffer: [a]; DLQ: [] */
    s.enqueue('b'); /* evicts a → DLQ: [a]; buffer: [b] */
    s.enqueue('c'); /* evicts b → DLQ full → overflowDrops++ */
    assert.equal(s.snapshot().overflowDrops, 1);
  });
});

describe('SiemDelivery — drainDeadLetter', () => {
  it('returns and clears dead-letter queue', async () => {
    const t = new StubTransport();
    t.mode = 'permanent';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0 });
    s.enqueue('e1');
    s.enqueue('e2');
    await s.flush();
    const drained = s.drainDeadLetter();
    assert.deepEqual(drained, ['e1', 'e2']);
    assert.equal(s.snapshot().deadLettered, 0);
  });
});

/* ── 审计 Warning B1-9：并发 flush 的重复投递 + 事件丢失 ────────────────
 * flush() 原实现「peek buffer[0] → await deliver → shift()」，peek 与 shift 之间
 * 有 await 断点。两个 flush 并发时都读到同一条 A：A 被投递两次，随后两次 shift
 * 分别删掉 A 和 B——B 从未投递却永久消失。定时器与外部调用天然并发，非理论风险。 */
class GatedTransport implements SiemTransport {
  delivered: string[] = [];
  private release!: () => void;
  readonly firstCallEntered: Promise<void>;
  private signalEntered!: () => void;
  private entered = false;

  constructor() {
    this.firstCallEntered = new Promise((r) => { this.signalEntered = r; });
    /* 第一次 deliver 会挂起，直到测试显式放行，以此制造稳定的交错窗口。 */
    this.gate = new Promise((r) => { this.release = r; });
  }
  private gate: Promise<void>;

  async deliver(payload: string): Promise<{ ok: true }> {
    if (!this.entered) {
      this.entered = true;
      this.signalEntered();
      await this.gate;
    }
    this.delivered.push(payload);
    return { ok: true };
  }
  releaseGate(): void { this.release(); }
}

describe('SiemDelivery — 并发 flush', () => {
  it('并发 flush 不重复投递、不丢事件', async () => {
    const t = new GatedTransport();
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0 });
    s.enqueue('A'); s.enqueue('B');

    /* flush #1 进入 transport 并挂在 A 上，此时 flush #2 启动。 */
    const f1 = s.flush();
    await t.firstCallEntered;
    const f2 = s.flush();
    t.releaseGate();
    await Promise.all([f1, f2]);

    /* A、B 各恰好一次，顺序保持。 */
    assert.deepEqual(t.delivered, ['A', 'B']);
    assert.equal(s.snapshot().pending, 0);
    assert.equal(s.snapshot().delivered, 2);
  });
});

/* Codex 交叉审查补口：单飞的正确性不仅是「并发不重复」，还须保证
 * drain 等待期间入队的事件不会被漏掉（drain 循环读实时 buffer.length 而非启动快照）。 */
describe('SiemDelivery — drain 期间入队', () => {
  it('投递挂起期间入队的新事件仍会被同一轮 drain 处理', async () => {
    const t = new GatedTransport();
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0 });
    s.enqueue('A');

    const f = s.flush();
    await t.firstCallEntered;   /* 此刻 A 正挂在 transport 里 */
    s.enqueue('B');             /* drain 进行中入队 */
    t.releaseGate();
    await f;

    assert.deepEqual(t.delivered, ['A', 'B'], 'B 不得被漏掉');
    assert.equal(s.snapshot().pending, 0);
  });
});
