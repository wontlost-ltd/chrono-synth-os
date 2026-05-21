/**
 * P3-A — error reporter tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NullErrorReporter, HttpErrorReporter, type ErrorEvent } from '../../observability/error-reporter.js';

describe('NullErrorReporter', () => {
  it('captures events for test assertions', async () => {
    const r = new NullErrorReporter();
    await r.report({ message: 'boom', level: 'error' });
    assert.equal(r.captured.length, 1);
    assert.equal(r.captured[0].message, 'boom');
  });

  it('scrubs PII even on the null path', async () => {
    const r = new NullErrorReporter();
    await r.report({
      message: 'login failed for alice@evil.com',
      level: 'warning',
    });
    assert.equal(r.captured[0].message.includes('alice@evil.com'), false,
      'null reporter must scrub PII identically to HTTP; otherwise tests miss leakage that prod has');
    assert.match(r.captured[0].message, /REDACTED_EMAIL/);
  });

  it('scrubs PII inside extras', async () => {
    const r = new NullErrorReporter();
    await r.report({
      message: 'see context',
      level: 'error',
      extra: { lastInput: 'call me at 13912345678' },
    });
    const extras = r.captured[0].extra!;
    assert.equal(JSON.stringify(extras).includes('13912345678'), false);
  });

  it('bounded — never exceeds 1000 captured', async () => {
    const r = new NullErrorReporter();
    for (let i = 0; i < 1100; i += 1) {
      await r.report({ message: `event-${i}`, level: 'info' });
    }
    assert.equal(r.captured.length, 1000);
    /* Newest events retained — bounded ring drops the head. */
    assert.equal(r.captured[r.captured.length - 1].message, 'event-1099');
  });
});

describe('HttpErrorReporter — construction', () => {
  it('refuses non-HTTPS endpoint', () => {
    assert.throws(
      () => new HttpErrorReporter({
        endpoint: 'http://insecure.example/store/', publicKey: 'pk',
        release: 'v1', environment: 'test',
        maxEventsPerSecond: 10, timeoutMs: 1000,
      }),
      /HTTPS/,
    );
  });

  it('refuses empty public key', () => {
    assert.throws(
      () => new HttpErrorReporter({
        endpoint: 'https://sentry.example/store/', publicKey: '',
        release: 'v1', environment: 'test',
        maxEventsPerSecond: 10, timeoutMs: 1000,
      }),
      /publicKey/,
    );
  });
});

describe('HttpErrorReporter — rate limiting', () => {
  it('drops events past maxEventsPerSecond + counts them', async () => {
    /* Build a reporter pointed at a deliberately unreachable URL.
     * fetch will fail but we only care about the gating logic, not
     * the transport itself. */
    const r = new HttpErrorReporter({
      endpoint: 'https://127.0.0.1:1/store/', publicKey: 'pk',
      release: 'v1', environment: 'test',
      maxEventsPerSecond: 2, timeoutMs: 100,
    });
    const event: ErrorEvent = { message: 'x', level: 'error' };
    /* Fire 5 events synchronously — only 2 hit the wire each window. */
    const p = Promise.all([
      r.report(event), r.report(event), r.report(event), r.report(event), r.report(event),
    ]);
    await p;
    const snap = r.snapshot();
    assert.equal(snap.dropped, 3);
  });
});

describe('HttpErrorReporter — never throws (error-handler contract)', () => {
  it('returns false on transport failure rather than throwing', async () => {
    const r = new HttpErrorReporter({
      endpoint: 'https://127.0.0.1:1/store/', publicKey: 'pk',
      release: 'v1', environment: 'test',
      maxEventsPerSecond: 10, timeoutMs: 50,
    });
    const result = await r.report({ message: 'boom', level: 'fatal' });
    assert.equal(result, false);
    /* Reporting must NOT have thrown — error handlers depend on this. */
  });
});
