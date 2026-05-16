/**
 * 单元测试：core/* Store 类支持 IDatabase 与 SyncWriteUnitOfWork 双入口
 * （Phase 2 批次 1 验收）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { TestClock } from '../../utils/clock.js';
import { ValueStore } from '../../core/value-store.js';
import { NarrativeStore } from '../../core/narrative-store.js';
import { CognitiveModelStore } from '../../core/cognitive-model-store.js';
import { DecisionStyleStore } from '../../core/decision-style-store.js';
import { SurvivalAnchorStore } from '../../core/survival-anchor-store.js';
import { CognitiveMemoryGraph } from '../../core/memory-graph.js';

const clock = new TestClock(1000);

describe('Phase 2 批次 1：core stores 双入口', () => {
  it('ValueStore 可接受 IDatabase 或 SyncWriteUnitOfWork', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new ValueStore(db, clock);
      const v1 = fromDb.create('curiosity', 0.8);
      assert.ok(v1.id);

      const fromUow = new ValueStore(db, clock);
      const v2 = fromUow.create('honesty', 0.7);
      assert.ok(v2.id);

      assert.equal(fromUow.getAll().size, 2);
    } finally {
      db.close();
    }
  });

  it('NarrativeStore 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const store = new NarrativeStore(db, clock);
      store.set('我是一个测试人格');
      assert.equal(store.get(), '我是一个测试人格');
    } finally {
      db.close();
    }
  });

  it('CognitiveModelStore 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const store = new CognitiveModelStore(db, clock);
      const model = store.set({ growthMindset: 0.6 });
      assert.equal(model.growthMindset, 0.6);
    } finally {
      db.close();
    }
  });

  it('DecisionStyleStore 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const store = new DecisionStyleStore(db, clock);
      const updated = store.set({ explorationBias: 0.4 });
      assert.equal(updated.explorationBias, 0.4);
    } finally {
      db.close();
    }
  });

  it('SurvivalAnchorStore 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const store = new SurvivalAnchorStore(db, clock);
      const anchor = store.create('健康', 'must_have', { metric: 'energy' }, 3);
      assert.ok(anchor.id);
      assert.equal(store.getAll().length, 1);
    } finally {
      db.close();
    }
  });

  it('CognitiveMemoryGraph IDatabase 形态：多步原子操作仍走 db.transaction', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const graph = new CognitiveMemoryGraph(db, clock);
      const m1 = graph.addMemory('episodic', 'test memory 1', 0.5, 0.8);
      assert.ok(m1.id);
      /* decayAll 内部使用 db.transaction 包裹 */
      const result = graph.decayAll();
      assert.ok(Array.isArray(result.decayed));
    } finally {
      db.close();
    }
  });

  it('CognitiveMemoryGraph SyncWriteUnitOfWork 形态：方法直接执行（不嵌套事务）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const uow = db;
      const graph = new CognitiveMemoryGraph(uow, clock);
      const m = graph.addMemory('episodic', 'sync uow memory', 0, 0.7);
      assert.ok(m.id);
      /* decayAll 在 UoW 模式下也能跑（不再嵌套 db.transaction） */
      const result = graph.decayAll();
      assert.ok(Array.isArray(result.decayed));
    } finally {
      db.close();
    }
  });
});
