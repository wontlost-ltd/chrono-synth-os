import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictInboxItemV1Schema,
  ConflictResolveRequestV1Schema,
  ConflictResolveResultV1Schema,
} from '../src/conflict/conflict-inbox.js';

const validInboxItem = {
  schemaVersion: 'conflict-inbox.v1' as const,
  conflictId: 'conflict-001',
  conflictVersion: 'v1',
  tenantId: 'tenant-001',
  entityType: 'memory' as const,
  entityId: 'mem-001',
  sourceRuntime: 'web' as const,
  detectedAt: '2026-03-15T00:00:00Z',
  severity: 'blocking' as const,
  localSummaryId: 'summary-local',
  localSummaryParams: { field: 'name', count: 1 },
  serverSummaryId: 'summary-server',
  serverSummaryParams: { field: 'name', count: 2 },
  suggestedActions: ['keep_local' as const, 'keep_server' as const],
};

describe('ConflictInboxItemV1Schema', () => {
  it('accepts a valid inbox item', () => {
    const result = ConflictInboxItemV1Schema.safeParse(validInboxItem);
    assert.equal(result.success, true);
  });

  it('accepts all entity types', () => {
    for (const entityType of ['persona', 'memory', 'task', 'device', 'policy'] as const) {
      const result = ConflictInboxItemV1Schema.safeParse({ ...validInboxItem, entityType });
      assert.equal(result.success, true, `should accept entityType: ${entityType}`);
    }
  });

  it('accepts all source runtimes', () => {
    for (const sourceRuntime of ['web', 'mobile', 'desktop', 'node'] as const) {
      const result = ConflictInboxItemV1Schema.safeParse({ ...validInboxItem, sourceRuntime });
      assert.equal(result.success, true, `should accept sourceRuntime: ${sourceRuntime}`);
    }
  });

  it('accepts optional commandId', () => {
    const result = ConflictInboxItemV1Schema.safeParse({
      ...validInboxItem,
      commandId: 'cmd-001',
    });
    assert.equal(result.success, true);
  });

  it('rejects empty suggestedActions', () => {
    const result = ConflictInboxItemV1Schema.safeParse({
      ...validInboxItem,
      suggestedActions: [],
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = ConflictInboxItemV1Schema.safeParse({
      ...validInboxItem,
      extra: 'unwanted',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty conflictId', () => {
    const result = ConflictInboxItemV1Schema.safeParse({
      ...validInboxItem,
      conflictId: '',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid detectedAt timestamp', () => {
    const result = ConflictInboxItemV1Schema.safeParse({
      ...validInboxItem,
      detectedAt: 'not-a-date',
    });
    assert.equal(result.success, false);
  });

  it('accepts detectedAt with timezone offset', () => {
    const result = ConflictInboxItemV1Schema.safeParse({
      ...validInboxItem,
      detectedAt: '2026-03-15T08:00:00+08:00',
    });
    assert.equal(result.success, true);
  });
});

describe('ConflictResolveRequestV1Schema', () => {
  const validRequest = {
    conflictId: 'conflict-001',
    ifMatch: 'v1',
    action: 'keep_local' as const,
  };

  it('accepts a valid resolve request', () => {
    const result = ConflictResolveRequestV1Schema.safeParse(validRequest);
    assert.equal(result.success, true);
  });

  it('accepts non-merge actions without mergePayload', () => {
    for (const action of ['keep_local', 'keep_server', 'duplicate'] as const) {
      const result = ConflictResolveRequestV1Schema.safeParse({ ...validRequest, action });
      assert.equal(result.success, true, `should accept action: ${action}`);
    }
  });

  it('accepts merge_manually with mergePayload', () => {
    const result = ConflictResolveRequestV1Schema.safeParse({
      ...validRequest,
      action: 'merge_manually',
      mergePayload: { name: 'merged-value' },
    });
    assert.equal(result.success, true);
  });

  it('rejects merge_manually without mergePayload', () => {
    const result = ConflictResolveRequestV1Schema.safeParse({
      ...validRequest,
      action: 'merge_manually',
    });
    assert.equal(result.success, false);
  });

  it('rejects mergePayload for non-merge actions', () => {
    const result = ConflictResolveRequestV1Schema.safeParse({
      ...validRequest,
      action: 'keep_local',
      mergePayload: { name: 'x' },
    });
    assert.equal(result.success, false);
  });

  it('provides TOCTOU protection via ifMatch', () => {
    const result = ConflictResolveRequestV1Schema.safeParse({
      ...validRequest,
      ifMatch: '',
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = ConflictResolveRequestV1Schema.safeParse({
      ...validRequest,
      extra: true,
    });
    assert.equal(result.success, false);
  });
});

describe('ConflictResolveResultV1Schema', () => {
  const validResult = {
    schemaVersion: 'conflict-resolve-result.v1' as const,
    conflictId: 'conflict-001',
    action: 'keep_local' as const,
    resolvedAt: '2026-03-15T00:01:00Z',
    resultingSyncState: 'online_synced' as const,
    remainingBlockingCount: 0,
  };

  it('accepts a valid resolve result', () => {
    const result = ConflictResolveResultV1Schema.safeParse(validResult);
    assert.equal(result.success, true);
  });

  it('accepts all resulting sync states', () => {
    for (const state of ['online_synced', 'syncing', 'conflict_inbox'] as const) {
      const result = ConflictResolveResultV1Schema.safeParse({
        ...validResult,
        resultingSyncState: state,
      });
      assert.equal(result.success, true, `should accept resultingSyncState: ${state}`);
    }
  });

  it('rejects negative remainingBlockingCount', () => {
    const result = ConflictResolveResultV1Schema.safeParse({
      ...validResult,
      remainingBlockingCount: -1,
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid resolvedAt timestamp', () => {
    const result = ConflictResolveResultV1Schema.safeParse({
      ...validResult,
      resolvedAt: 'not-a-date',
    });
    assert.equal(result.success, false);
  });
});
