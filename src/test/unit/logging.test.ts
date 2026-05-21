import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { context as otelContext, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PinoLogger } from '../../logging/index.js';
import type { Logger } from '../../utils/logger.js';

describe('PinoLogger', () => {
  it('实现 Logger 接口四个方法', () => {
    const logger: Logger = new PinoLogger('warn');
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
  });

  it('所有日志方法不抛异常', () => {
    const logger = new PinoLogger('error');
    assert.doesNotThrow(() => logger.debug('test', '调试消息'));
    assert.doesNotThrow(() => logger.info('test', '信息消息'));
    assert.doesNotThrow(() => logger.warn('test', '警告消息'));
    assert.doesNotThrow(() => logger.error('test', '错误消息', { err: 'detail' }));
  });

  it('pino getter 返回底层实例', () => {
    const logger = new PinoLogger('info');
    assert.ok(logger.pino);
    assert.equal(typeof logger.pino.info, 'function');
  });

  it('child 创建子日志器', () => {
    const logger = new PinoLogger('info');
    const child = logger.child({ requestId: 'req-123' });
    assert.ok(child instanceof PinoLogger);
    assert.doesNotThrow(() => child.info('test', '子日志消息'));
  });

  it('child 子日志器保持 Logger 接口兼容', () => {
    const logger = new PinoLogger('info');
    const child: Logger = logger.child({ correlationId: 'abc' });
    assert.equal(typeof child.debug, 'function');
    assert.equal(typeof child.info, 'function');
    assert.equal(typeof child.warn, 'function');
    assert.equal(typeof child.error, 'function');
  });

  it('OTel active span 时 mixin 注入 trace_id + span_id', () => {
    /* Need to register the TracerProvider so the api package's global
     * lookup returns our tracer. Tests do this manually rather than using
     * the SDK auto-instrumentation (which has side effects on the process).
     * SpanProcessor is required — without one, BasicTracerProvider falls
     * back to NonRecordingSpan whose spanContext().traceId is all-zeros. */
    /* The api package needs a ContextManager to propagate context across
     * sync/async boundaries. Without it, context.with() succeeds but
     * getActiveSpan() inside the callback returns nothing — same failure
     * mode whether sync or async. */
    const contextManager = new AsyncHooksContextManager().enable();
    otelContext.setGlobalContextManager(contextManager);
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    trace.setGlobalTracerProvider(provider);
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const tracer = trace.getTracer('test');
      const logger = new PinoLogger('info', true /* json */);
      const span = tracer.startSpan('test-span');
      otelContext.with(trace.setSpan(otelContext.active(), span), () => {
        logger.info('layer-x', 'in-span message');
      });
      span.end();
      assert.ok(lines.length > 0, 'expected at least one log line');
      const logLine = lines.find(l => l.includes('"layer":"layer-x"'));
      assert.ok(logLine, `no log with layer-x in ${JSON.stringify(lines)}`);
      const parsed = JSON.parse(logLine) as Record<string, unknown>;
      assert.equal(typeof parsed.trace_id, 'string', `expected trace_id string, got ${JSON.stringify(parsed)}`);
      assert.equal((parsed.trace_id as string).length, 32);
      assert.equal(typeof parsed.span_id, 'string');
      assert.equal((parsed.span_id as string).length, 16);
    } finally {
      process.stdout.write = originalWrite;
      trace.disable();
      otelContext.disable();
    }
  });

  it('no active span 时 mixin 不注入 trace_id', () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const logger = new PinoLogger('info', true);
      logger.info('layer-y', 'no-span message');
      const logLine = lines.find(l => l.includes('"layer":"layer-y"'));
      assert.ok(logLine);
      const parsed = JSON.parse(logLine) as Record<string, unknown>;
      assert.equal('trace_id' in parsed, false,
        `expected no trace_id, got ${JSON.stringify(parsed)}`);
      assert.equal('span_id' in parsed, false);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
