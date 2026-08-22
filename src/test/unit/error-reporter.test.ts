/**
 * P3-A — error reporter tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NullErrorReporter, HttpErrorReporter, type ErrorEvent } from '../../observability/error-reporter.js';
import { TestClock } from '../../utils/clock.js';

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
    /* ⚠️ 必须注入固定时钟：限流窗口是 1 秒**墙钟**，而 report() 内部要 await 真实网络尝试
     * （endpoint 不可达，靠 timeoutMs 兜底）。5 次调用由 Promise.all 并发发起，但第 3-5 条
     * 的限流判定发生在前面的 await 落定**之后** —— 一旦累计耗时跨过 1000ms，窗口翻转、
     * eventsInWindow 归零，就会多放行一条，dropped 变成 2。
     *
     * 实测同一用例连跑 4 次（真实时钟）：
     *   469ms → dropped 3 ✓ | 974ms → 3 ✓ | **1139ms → 2 ✗** | 832ms → 3 ✓
     * 耗时是否跨 1000ms 与成败**完全对应** —— 这是墙钟边界竞态，不是随机噪声，
     * 机器负载高时必现（本轮 test:golden 就红在这里）。
     *
     * 固定时钟让 now() 恒定 → 窗口永不翻转 → 断言只反映限流逻辑本身。 */
    const r = new HttpErrorReporter({
      endpoint: 'https://127.0.0.1:1/store/', publicKey: 'pk',
      release: 'v1', environment: 'test',
      maxEventsPerSecond: 2, timeoutMs: 100,
      clock: new TestClock(1000),
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

  it('窗口滚动后重新放行（固定时钟不得把限流「冻死」）', async () => {
    /* ⚠️ 对照用例：上一条把时钟钉死才让断言确定，但**只有那一条**就无法区分
     * 「限流正确」与「窗口逻辑坏掉、永远不放行」。这里显式推进时钟过 1 秒，
     * 断言新窗口重新放行 —— 钉死时钟不能把被测行为一起钉没。 */
    const clock = new TestClock(1000);
    const r = new HttpErrorReporter({
      endpoint: 'https://127.0.0.1:1/store/', publicKey: 'pk',
      release: 'v1', environment: 'test',
      maxEventsPerSecond: 2, timeoutMs: 100, clock,
    });
    const event: ErrorEvent = { message: 'x', level: 'error' };

    await Promise.all([r.report(event), r.report(event), r.report(event)]);
    assert.equal(r.snapshot().dropped, 1, '第一个窗口：放行 2、丢 1');

    /* 推进过 1 秒 → 新窗口。 */
    clock.advance(1001);
    await Promise.all([r.report(event), r.report(event), r.report(event)]);
    assert.equal(r.snapshot().dropped, 2, '新窗口应重新放行 2 条，累计丢弃 1+1=2');
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
