import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations, type IDatabase } from '../../storage/index.js';
import {
  countBlockingConflicts,
  createConflict,
  getConflict,
  listConflicts,
  resolveConflict,
  type ConflictInboxRow,
} from '../../privacy/conflict-inbox-store.js';

function baseConflict(overrides: Partial<Omit<ConflictInboxRow, 'resolved_at' | 'resolution_action'>> = {}): Omit<ConflictInboxRow, 'resolved_at' | 'resolution_action'> {
  return {
    conflict_id: 'conflict_1',
    conflict_version: 'v1',
    tenant_id: 'tenant_1',
    entity_type: 'memory',
    entity_id: 'memory_1',
    command_id: 'command_1',
    source_runtime: 'web',
    detected_at: '2026-05-02T01:00:00.000Z',
    severity: 'warning',
    local_summary_id: 'conflict.local',
    local_summary_params: '{"title":"local"}',
    server_summary_id: 'conflict.server',
    server_summary_params: '{"title":"server"}',
    suggested_actions: '["keep_server"]',
    ...overrides,
  };
}

function withDb(fn: (db: IDatabase) => void): void {
  const db = createMemoryDatabase();
  try {
    runDslSqliteMigrations(db);
    fn(db);
  } finally {
    db.close();
  }
}

describe('ConflictInboxStore', () => {
  it('round-trips createConflict and getConflict', () => withDb((db) => {
    const item = baseConflict();
    createConflict(db, item);

    const row = getConflict(db, item.conflict_id);
    assert.deepEqual(row ? { ...row } : null, {
      ...item,
      resolved_at: null,
      resolution_action: null,
    });
  }));

  it('createConflict() rejects duplicate conflict_id', () => withDb((db) => {
    const item = baseConflict();
    createConflict(db, item);

    assert.throws(() => createConflict(db, item));
  }));

  it('listConflicts() is scoped to the requested tenant', () => withDb((db) => {
    createConflict(db, baseConflict({ conflict_id: 'tenant_1_conflict', tenant_id: 'tenant_1' }));
    createConflict(db, baseConflict({ conflict_id: 'tenant_2_conflict', tenant_id: 'tenant_2' }));

    const rows = listConflicts(db, 'tenant_1');

    assert.equal(rows.length, 1);
    assert.ok(rows.every((row) => row.tenant_id === 'tenant_1'));
  }));

  it('listConflicts returns only unresolved conflicts when requested', () => withDb((db) => {
    createConflict(db, baseConflict({ conflict_id: 'conflict_open' }));
    createConflict(db, baseConflict({ conflict_id: 'conflict_done' }));
    assert.equal(resolveConflict(db, 'conflict_done', 'keep_server', '2026-05-02T02:00:00.000Z'), true);

    const unresolved = listConflicts(db, 'tenant_1', true);
    assert.deepEqual(unresolved.map((row) => row.conflict_id), ['conflict_open']);
  }));

  it('resolveConflict returns false for an unknown conflictId', () => withDb((db) => {
    assert.equal(resolveConflict(db, 'missing', 'keep_server', '2026-05-02T02:00:00.000Z'), false);
  }));

  it('resolveConflict() returns false when already resolved', () => withDb((db) => {
    createConflict(db, baseConflict());

    assert.equal(resolveConflict(db, 'conflict_1', 'keep_server', '2026-05-02T02:00:00.000Z'), true);
    assert.equal(resolveConflict(db, 'conflict_1', 'keep_server', '2026-05-02T03:00:00.000Z'), false);
  }));

  it('getConflict() returns null for missing id', () => withDb((db) => {
    assert.equal(getConflict(db, 'nonexistent'), null);
  }));

  it('countBlockingConflicts counts only unresolved blocking conflicts', () => withDb((db) => {
    createConflict(db, baseConflict({ conflict_id: 'blocking_open', severity: 'blocking' }));
    createConflict(db, baseConflict({ conflict_id: 'blocking_done', severity: 'blocking' }));
    createConflict(db, baseConflict({ conflict_id: 'warning_open', severity: 'warning' }));
    createConflict(db, baseConflict({ conflict_id: 'other_tenant', tenant_id: 'tenant_2', severity: 'blocking' }));
    assert.equal(resolveConflict(db, 'blocking_done', 'keep_server', '2026-05-02T02:00:00.000Z'), true);

    assert.equal(countBlockingConflicts(db, 'tenant_1'), 1);
  }));
});
