import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { _resetTracingForTest, flushTraces, tracer } from './tracing';

/**
 * P3.3 — OTel browser SDK boundary tests. We don't assert span body
 * contents (the OTel SDK is its own extensively-tested codebase); we
 * pin the project-internal API that callsites depend on:
 *   - startSpan / withSpan return a Span the caller can use without throwing
 *   - withSpan returns the function result on success
 *   - withSpan re-throws errors after recording the exception
 *   - flushTraces resolves cleanly even when no spans were created
 */

describe('tracing (OTel browser SDK boundary)', () => {
  beforeEach(() => {
    _resetTracingForTest();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetTracingForTest();
  });

  it('startSpan returns a span object exposing the public methods', () => {
    const span = tracer.startSpan('test.span');
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe('function');
    expect(typeof span.addEvent).toBe('function');
    expect(typeof span.setStatus).toBe('function');
    expect(typeof span.recordException).toBe('function');
    expect(typeof span.end).toBe('function');

    expect(() => {
      span.setAttribute('foo', 'bar');
      span.setAttribute('count', 42);
      span.setAttribute('flag', true);
      span.setAttribute('null_value', null);
      span.addEvent('my.event', { key: 'value' });
      span.setStatus('OK');
      span.end();
    }).not.toThrow();
  });

  it('withSpan returns the function result on success', async () => {
    const result = await tracer.withSpan('test.with', () => 42);
    expect(result).toBe(42);
  });

  it('withSpan re-throws the original error after recording', async () => {
    const err = new Error('boom');
    await expect(tracer.withSpan('test.with-error', () => { throw err; })).rejects.toThrow('boom');
  });

  it('withSpan handles non-Error throws without crashing', async () => {
    await expect(tracer.withSpan('test.string-throw', () => {
      throw 'a string';
    })).rejects.toBe('a string');
  });

  it('flushTraces resolves cleanly even before any span is created', async () => {
    await expect(flushTraces()).resolves.toBeUndefined();
  });

  it('async work inside withSpan completes', async () => {
    const result = await tracer.withSpan('test.async', async (span) => {
      span.setAttribute('phase', 'start');
      await Promise.resolve();
      span.setAttribute('phase', 'end');
      return 'async-done';
    });
    expect(result).toBe('async-done');
  });
});
