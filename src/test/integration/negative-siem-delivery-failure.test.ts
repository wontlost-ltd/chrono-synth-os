/**
 * Negative integration test — SIEM delivery resilience.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §4 P1-Q-3 + §8 #22
 *
 * Activated once SiemDelivery shipped. Covers:
 *   - SIEM endpoint unreachable → events accumulate in buffer + retry,
 *     no events dropped on the floor
 *   - 4xx (permanent) response → goes straight to dead-letter
 *   - 5xx (transient) response → retried up to maxRetries then dead-lettered
 *   - Buffer overflow → oldest events go to dead-letter, not silently lost
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SiemDelivery, DEFAULT_SIEM_OPTIONS, type SiemTransport,
} from '../../siem/siem-delivery.js';

class FlakyTransport implements SiemTransport {
  mode: 'ok' | 'transient' | 'permanent' = 'transient';
  delivered: string[] = [];
  async deliver(payload: string): Promise<{ ok: true } | { ok: false; permanent: boolean; reason: string }> {
    if (this.mode === 'ok') {
      this.delivered.push(payload);
      return { ok: true };
    }
    return { ok: false, permanent: this.mode === 'permanent', reason: 'simulated' };
  }
}

describe('P1-Q-3 negative — SIEM delivery resilience', () => {
  it('endpoint unreachable → events buffered, none dropped', async () => {
    const t = new FlakyTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 10 });
    s.enqueue('e1'); s.enqueue('e2'); s.enqueue('e3');
    await s.flush();
    const snap = s.snapshot();
    assert.equal(snap.delivered, 0);
    assert.equal(snap.pending, 3);
    assert.equal(snap.deadLettered, 0);
    assert.equal(snap.overflowDrops, 0);
    t.mode = 'ok';
    await s.flush();
    assert.equal(s.snapshot().delivered, 3);
    assert.equal(s.snapshot().pending, 0);
  });

  it('4xx response → permanent failure, straight to dead-letter', async () => {
    const t = new FlakyTransport();
    t.mode = 'permanent';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 5 });
    s.enqueue('schema-invalid');
    await s.flush();
    const snap = s.snapshot();
    assert.equal(snap.deadLettered, 1);
    assert.equal(snap.permanentFailures, 1);
    assert.equal(snap.transientFailures, 0);
  });

  it('repeated 5xx → eventual dead-letter (does not retry forever)', async () => {
    const t = new FlakyTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, { ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxRetries: 3 });
    s.enqueue('e');
    await s.flush(); await s.flush(); await s.flush();
    assert.equal(s.snapshot().deadLettered, 1);
    assert.equal(s.snapshot().pending, 0);
  });

  it('buffer overflow → oldest move to dead-letter, not silently lost', () => {
    const t = new FlakyTransport();
    t.mode = 'transient';
    const s = new SiemDelivery(t, {
      ...DEFAULT_SIEM_OPTIONS, flushIntervalMs: 0, maxBufferSize: 2, maxDeadLetterSize: 100,
    });
    for (let i = 0; i < 5; i += 1) s.enqueue(`e-${i}`);
    const snap = s.snapshot();
    assert.equal(snap.pending, 2);
    assert.equal(snap.deadLettered, 3);
    assert.equal(snap.overflowDrops, 0,
      'with DLQ still spacious, evictions must NOT count as dropped events');
  });
});
