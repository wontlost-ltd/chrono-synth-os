/**
 * Tracing — OpenTelemetry browser SDK with the same API surface as
 * the previous shim.
 *
 * Default exporter: OTLP HTTP at `/api/v1/otel/v1/traces`. The path is
 * proxied by nginx in production; runtime-config can override via
 * __CHRONO_RUNTIME_CONFIG__.otelTraceEndpoint.
 *
 * Sampling: 1% by default; setting `chrono.flag.otel.always-sample=true`
 * in localStorage forces 100% (debugging a single user's session).
 *
 * Initialization happens once on first call; if the runtime config
 * has otelDisable=true the tracer collapses to a no-op without
 * touching the network.
 */

import {
  trace,
  context,
  SpanStatusCode,
  type Span as OtelSpan,
  type Tracer as OtelTracer,
} from '@opentelemetry/api';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = 'chrono-synth-web';
const TRACER_NAME = SERVICE_NAME;
const DEFAULT_ENDPOINT = '/api/v1/otel/v1/traces';

export type SpanStatusName = 'OK' | 'ERROR' | 'UNSET';

export interface Span {
  setAttribute(key: string, value: string | number | boolean | null): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  setStatus(code: SpanStatusName, message?: string): void;
  recordException(err: unknown): void;
  end(): void;
}

interface RuntimeConfig {
  environment?: string;
  otelTraceEndpoint?: string;
  otelDisable?: boolean;
}

function readRuntimeConfig(): RuntimeConfig {
  if (typeof window === 'undefined') return {};
  const cfg = (window as unknown as { __CHRONO_RUNTIME_CONFIG__?: RuntimeConfig }).__CHRONO_RUNTIME_CONFIG__;
  return cfg ?? {};
}

function readSampleRate(): number {
  if (typeof window === 'undefined') return 0.01;
  try {
    const flag = window.localStorage.getItem('chrono.flag.otel.always-sample');
    if (flag === 'true') return 1.0;
  } catch {
    /* ignore */
  }
  return 0.01;
}

let initialized = false;
let realTracer: OtelTracer | null = null;
let processor: BatchSpanProcessor | null = null;

function initOnce(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const cfg = readRuntimeConfig();
  if (cfg.otelDisable) return;

  const sampleRate = readSampleRate();
  const exporter = new OTLPTraceExporter({ url: cfg.otelTraceEndpoint ?? DEFAULT_ENDPOINT });
  const proc = new BatchSpanProcessor(exporter, {
    maxQueueSize: 256,
    maxExportBatchSize: 64,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 30000,
  });
  processor = proc;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: '2.0.0',
      'deployment.environment': cfg.environment ?? 'unknown',
    }),
    sampler: sampleRate >= 1 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(sampleRate),
    spanProcessors: [proc],
  });
  provider.register({ contextManager: new ZoneContextManager() });
  realTracer = trace.getTracer(TRACER_NAME, '2.0.0');

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void proc.forceFlush();
      }
    });
  }
}

class NoopSpan implements Span {
  setAttribute(): void { /* noop */ }
  addEvent(): void { /* noop */ }
  setStatus(): void { /* noop */ }
  recordException(): void { /* noop */ }
  end(): void { /* noop */ }
}

const NOOP = new NoopSpan();

class SpanWrapper implements Span {
  constructor(private readonly inner: OtelSpan) {}

  setAttribute(key: string, value: string | number | boolean | null): void {
    /* OTel rejects null values; coerce to empty-string. */
    this.inner.setAttribute(key, value === null ? '' : value);
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    this.inner.addEvent(
      name,
      attributes as Record<string, string | number | boolean> | undefined,
    );
  }

  setStatus(code: SpanStatusName, message?: string): void {
    const otelCode =
      code === 'OK' ? SpanStatusCode.OK : code === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET;
    this.inner.setStatus({ code: otelCode, message });
  }

  recordException(err: unknown): void {
    if (err instanceof Error) {
      this.inner.recordException(err);
    } else {
      this.inner.recordException({ name: 'NonError', message: String(err) });
    }
    this.setStatus('ERROR', err instanceof Error ? err.message : String(err));
  }

  end(): void {
    this.inner.end();
  }
}

class TracerFacade {
  startSpan(name: string): Span {
    initOnce();
    if (!realTracer) return NOOP;
    return new SpanWrapper(realTracer.startSpan(name));
  }

  async withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T> {
    initOnce();
    if (!realTracer) return fn(NOOP);

    const inner = realTracer.startSpan(name);
    const wrapper = new SpanWrapper(inner);
    const ctx = trace.setSpan(context.active(), inner);
    try {
      const result = await context.with(ctx, () => fn(wrapper));
      wrapper.setStatus('OK');
      return result;
    } catch (err) {
      wrapper.recordException(err);
      throw err;
    } finally {
      wrapper.end();
    }
  }
}

export const tracer = new TracerFacade();

export function flushTraces(): Promise<void> {
  return processor?.forceFlush() ?? Promise.resolve();
}

/* Test helpers. The previous shim's in-memory ring buffer + getBufferedSpans
 * is gone — assertions now check the no-op fallback path (tracer is in
 * disabled state) rather than introspecting the OTel BatchSpanProcessor. */
export function _resetTracingForTest(): void {
  initialized = false;
  realTracer = null;
  processor = null;
}
