import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSyncEventSchema } from '../src/sync/runtime-sync-events.js';

describe('RuntimeSyncEventSchema', () => {
  it('accepts a valid sync.disabled event', () => {
    const result = RuntimeSyncEventSchema.safeParse({
      type: 'sync.disabled',
      occurredAt: 1,
    });
    assert.equal(result.success, true);
  });

  it('rejects unknown fields', () => {
    const result = RuntimeSyncEventSchema.safeParse({
      type: 'sync.disabled',
      occurredAt: 1,
      extra: 'x',
    });
    assert.equal(result.success, false);
  });

  it('rejects an unknown event type', () => {
    const result = RuntimeSyncEventSchema.safeParse({
      type: 'sync.unknown',
      occurredAt: 1,
    });
    assert.equal(result.success, false);
  });

  it('rejects negative timestamps', () => {
    const result = RuntimeSyncEventSchema.safeParse({
      type: 'sync.disabled',
      occurredAt: -1,
    });
    assert.equal(result.success, false);
  });
});
