/**
 * Telemetry tests.
 *
 * The single most important assertion: events MUST NOT carry conflictId,
 * entityId, tenantId, or any free-form identifying field. If a future
 * refactor adds those keys, this test fails the build.
 */

import { afterEach, describe, it, expect } from 'vitest';
import {
  _resetTelemetrySinkForTest,
  emitConflictTelemetry,
  setTelemetrySink,
  type ConflictTelemetryEvent,
} from './conflicts';

afterEach(() => {
  _resetTelemetrySinkForTest();
});

describe('conflict telemetry', () => {
  it('routes events through the installed sink', () => {
    const captured: ConflictTelemetryEvent[] = [];
    setTelemetrySink((event) => captured.push(event));

    emitConflictTelemetry({
      kind: 'conflict.view',
      entityType: 'persona',
      severity: 'blocking',
    });
    emitConflictTelemetry({
      kind: 'conflict.resolve.complete',
      entityType: 'memory',
      action: 'keep_server',
      outcome: 'success',
      durationMs: 1234,
    });

    expect(captured).toHaveLength(2);
  });

  it('emits events that contain NO identifying fields (no entityId / conflictId / tenantId)', () => {
    const captured: ConflictTelemetryEvent[] = [];
    setTelemetrySink((event) => captured.push(event));

    emitConflictTelemetry({
      kind: 'conflict.resolve.attempt',
      entityType: 'task',
      action: 'merge_manually',
    });

    const event = captured[0]!;
    /* JSON round-trip → object keys. Belt-and-braces check that no
     * forbidden keys appear in any future variant. */
    const keys = Object.keys(event);
    expect(keys).not.toContain('entityId');
    expect(keys).not.toContain('conflictId');
    expect(keys).not.toContain('tenantId');
    expect(keys).not.toContain('userId');
    expect(keys).not.toContain('email');
  });

  it('never throws when the sink throws (fail-open)', () => {
    setTelemetrySink(() => {
      throw new Error('boom');
    });
    expect(() => emitConflictTelemetry({
      kind: 'conflict.view',
      entityType: 'device',
      severity: 'warning',
    })).not.toThrow();
  });

  it('no-op sink before setTelemetrySink — production safe default', () => {
    /* Just resetting and emitting; success = no throw. */
    _resetTelemetrySinkForTest();
    expect(() => emitConflictTelemetry({
      kind: 'conflict.view',
      entityType: 'policy',
      severity: 'blocking',
    })).not.toThrow();
  });
});
