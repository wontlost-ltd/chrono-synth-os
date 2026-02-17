import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { SnapshotStore } from '../../recovery/snapshot-store.js';
import type { SystemSnapshot } from '../../types/snapshot.js';

describe('SnapshotStore', () => {
  let db: IDatabase;
  let store: SnapshotStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    store = new SnapshotStore(db);
  });

  function makeSnapshot(id: string, createdAt: number): SystemSnapshot {
    return {
      id,
      coreSelf: {
        values: new Map([['v1', { id: 'v1', label: 'honesty', weight: 0.8, updatedAt: 100 }]]),
        memories: new Map(),
        edges: [],
        narrative: '测试叙事',
        survivalAnchors: [],
        decisionStyle: {
          riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.3,
          lossAversion: 2.0, deliberationDepth: 3, regretSensitivity: 0.5, updatedAt: 0,
        },
        cognitiveModel: {
          beliefs: new Map(), biasWeights: new Map(),
          attributionStyle: 0.5, growthMindset: 0.5, updatedAt: 0,
        },
        updatedAt: createdAt,
      },
      personas: [],
      activeConflicts: [],
      allocations: [],
      createdAt,
      reason: 'manual',
    };
  }

  it('保存和加载快照', () => {
    const snap = makeSnapshot('s1', 1000);
    store.save(snap);

    const loaded = store.load('s1');
    assert.ok(loaded);
    assert.equal(loaded!.id, 's1');
    assert.equal(loaded!.coreSelf.narrative, '测试叙事');
    /* 验证 Map 正确恢复 */
    assert.ok(loaded!.coreSelf.values instanceof Map);
    assert.equal(loaded!.coreSelf.values.get('v1')!.label, 'honesty');
  });

  it('加载不存在的快照返回 undefined', () => {
    assert.equal(store.load('nonexistent'), undefined);
  });

  it('getLatest 返回最新快照', () => {
    store.save(makeSnapshot('s1', 1000));
    store.save(makeSnapshot('s2', 2000));
    store.save(makeSnapshot('s3', 1500));

    const latest = store.getLatest();
    assert.equal(latest!.id, 's2');
  });

  it('list 返回按时间倒序的列表', () => {
    store.save(makeSnapshot('s1', 1000));
    store.save(makeSnapshot('s2', 3000));
    store.save(makeSnapshot('s3', 2000));

    const list = store.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].id, 's2');
    assert.equal(list[1].id, 's3');
    assert.equal(list[2].id, 's1');
  });

  it('delete 删除快照', () => {
    store.save(makeSnapshot('s1', 1000));
    assert.ok(store.delete('s1'));
    assert.equal(store.load('s1'), undefined);
    assert.ok(!store.delete('nonexistent'));
  });
});
