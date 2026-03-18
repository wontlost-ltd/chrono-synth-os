import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAP_QUERY_BY_ID, SNAP_QUERY_LATEST, SNAP_QUERY_LIST,
  SNAP_CMD_SAVE, SNAP_CMD_DELETE, EVO_CMD_PERSIST,
  UGATE_QUERY_BY_ID, UGATE_QUERY_PENDING,
  UGATE_CMD_PROPOSE, UGATE_CMD_SET_STATUS,
  CONFLICT_QUERY_UNRESOLVED, CONFLICT_QUERY_ALL,
  CONFLICT_CMD_RECORD, CONFLICT_CMD_RESOLVE, CONFLICT_CMD_DELETE_ALL, CONFLICT_CMD_RESTORE,
} from '@chrono/kernel';
import { SnapshotStore } from '../../recovery/snapshot-store.js';
import { UpdateGate } from '../../meta/update-gate.js';
import { ConflictResolver } from '../../meta/conflict-resolver.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveQueryExecutor, resolveCommandExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';

describe('SnapshotStore 执行器注册', () => {
  beforeEach(() => { resetCoreSelfExecutors(); });

  it('全部 Snapshot/Evolution 执行器注册完整', () => {
    registerCoreSelfExecutors();
    assert.ok(resolveQueryExecutor(SNAP_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(SNAP_QUERY_LATEST));
    assert.ok(resolveQueryExecutor(SNAP_QUERY_LIST));
    assert.ok(resolveCommandExecutor(SNAP_CMD_SAVE));
    assert.ok(resolveCommandExecutor(SNAP_CMD_DELETE));
    assert.ok(resolveCommandExecutor(EVO_CMD_PERSIST));
  });

  it('save 和 load 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const store = new SnapshotStore(db);

    const snapshot = {
      id: 'snap-1', reason: '测试快照', createdAt: Date.now(),
      values: [], anchors: [], narrativeMode: 'balanced', decisionStyle: {},
      cognitiveModel: {}, memories: [], personas: [], conflicts: [],
    } as any;

    store.save(snapshot);
    const loaded = store.load('snap-1');
    assert.ok(loaded);
    assert.equal(loaded.id, 'snap-1');
    assert.equal(loaded.reason, '测试快照');
  });

  it('list 和 delete 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const store = new SnapshotStore(db);

    store.save({ id: 'snap-a', reason: 'A', createdAt: 1000 } as any);
    store.save({ id: 'snap-b', reason: 'B', createdAt: 2000 } as any);

    const list = store.list();
    assert.equal(list.length, 2);

    const deleted = store.delete('snap-a');
    assert.equal(deleted, true);
    assert.equal(store.list().length, 1);
  });
});

describe('UpdateGate 执行器注册', () => {
  beforeEach(() => { resetCoreSelfExecutors(); });

  it('全部 UpdateGate 执行器注册完整', () => {
    registerCoreSelfExecutors();
    assert.ok(resolveQueryExecutor(UGATE_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(UGATE_QUERY_PENDING));
    assert.ok(resolveCommandExecutor(UGATE_CMD_PROPOSE));
    assert.ok(resolveCommandExecutor(UGATE_CMD_SET_STATUS));
  });

  it('propose 和 approve 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const clock = { now: () => Date.now() };
    const gate = new UpdateGate(db, clock);

    const pending = gate.propose({
      layer: 'L0', trigger: 'statistical_drift', targetId: 'val-1',
      currentValue: '0.5', proposedValue: '0.9', delta: 0.4, reason: '测试',
    });
    assert.equal(pending.status, 'pending');

    const approved = gate.approve(pending.id);
    assert.ok(approved);
    assert.equal(approved.status, 'approved');
  });

  it('getPending 返回待处理项', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const clock = { now: () => Date.now() };
    const gate = new UpdateGate(db, clock);

    gate.propose({ layer: 'L1', trigger: 'statistical_drift', targetId: 'v-1', currentValue: '0', proposedValue: '1', delta: 1, reason: '' });
    gate.propose({ layer: 'L0', trigger: 'statistical_drift', targetId: 'v-2', currentValue: '0', proposedValue: '1', delta: 1, reason: '' });

    const pending = gate.getPending();
    assert.equal(pending.length, 2);
  });
});

describe('ConflictResolver 执行器注册', () => {
  beforeEach(() => { resetCoreSelfExecutors(); });

  it('全部 Conflict 执行器注册完整', () => {
    registerCoreSelfExecutors();
    assert.ok(resolveQueryExecutor(CONFLICT_QUERY_UNRESOLVED));
    assert.ok(resolveQueryExecutor(CONFLICT_QUERY_ALL));
    assert.ok(resolveCommandExecutor(CONFLICT_CMD_RECORD));
    assert.ok(resolveCommandExecutor(CONFLICT_CMD_RESOLVE));
    assert.ok(resolveCommandExecutor(CONFLICT_CMD_DELETE_ALL));
    assert.ok(resolveCommandExecutor(CONFLICT_CMD_RESTORE));
  });

  it('resolve 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const clock = { now: () => Date.now() };
    const resolver = new ConflictResolver(db, clock);

    // 直接插入冲突记录用于测试
    db.prepare<void>(
      `INSERT INTO conflicts (id, kind, severity, involved_versions_json, affected_values_json, description, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('c-1', 'value_divergence', 'medium', '["v1","v2"]', '["val-1"]', '测试冲突', Date.now());

    const unresolved = resolver.getUnresolved();
    assert.equal(unresolved.length, 1);

    const resolved = resolver.resolve('c-1', '手动解决');
    assert.equal(resolved, true);

    assert.equal(resolver.getUnresolved().length, 0);
    assert.equal(resolver.getAll().length, 1);
  });
});
