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
