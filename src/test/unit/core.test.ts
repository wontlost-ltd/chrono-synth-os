import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';

describe('CoreRhythmLayer', () => {
  let db: IDatabase;
  let bus: EventBus;
  let clock: TestClock;
  let logger: SilentLogger;
  let core: CoreRhythmLayer;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    bus = new EventBus();
    clock = new TestClock(1000);
    logger = new SilentLogger();
    core = new CoreRhythmLayer(db, bus, clock, logger);
  });

  describe('价值管理', () => {
    it('添加和获取价值', () => {
      const v = core.addValue('诚实', 0.8);
      assert.equal(v.label, '诚实');
      assert.equal(v.weight, 0.8);

      const state = core.getState();
      assert.equal(state.values.size, 1);
    });

    it('更新价值权重', () => {
      const v = core.addValue('勇气', 0.5);
      clock.advance(100);
      const updated = core.updateValue(v.id, 0.9);
      assert.ok(updated);
      assert.equal(updated!.weight, 0.9);
    });

    it('更新不存在的价值返回 undefined', () => {
      const result = core.updateValue('nonexistent', 0.5);
      assert.equal(result, undefined);
    });

    it('添加价值触发事件', () => {
      let emitted = false;
      bus.on('core:value-updated', () => { emitted = true; });
      core.addValue('智慧', 0.7);
      assert.ok(emitted);
    });
  });

  describe('记忆管理', () => {
    it('添加和检索记忆', () => {
      const m = core.addMemory('episodic', '第一次编程', 0.8, 0.9);
      assert.equal(m.kind, 'episodic');
      assert.equal(m.content, '第一次编程');
      assert.equal(m.accessCount, 0);
      assert.ok(m.decayLambda > 0);
      assert.equal(m.consolidatedFrom, null);

      const state = core.getState();
      assert.equal(state.memories.size, 1);
    });

    it('访问记忆更新时间戳和访问计数', () => {
      const m = core.addMemory('semantic', '知识片段', 0.3, 0.5);
      clock.advance(500);
      const accessed = core.accessMemory(m.id);
      assert.ok(accessed);
      assert.equal(accessed!.lastAccessedAt, 1500);
      assert.equal(accessed!.accessCount, 1);
    });

    it('关联记忆', () => {
      const m1 = core.addMemory('episodic', '事件A', 0.5, 0.5);
      const m2 = core.addMemory('episodic', '事件B', 0.3, 0.4);
      const edge = core.linkMemories(m1.id, m2.id, 'caused', 0.7);
      assert.equal(edge.strength, 0.7);
      assert.equal(edge.relation, 'caused');

      const state = core.getState();
      assert.equal(state.edges.length, 1);
    });
  });

  describe('叙事管理', () => {
    it('设置和获取叙事', () => {
      core.updateNarrative('我是一个数字人格');
      const state = core.getState();
      assert.equal(state.narrative, '我是一个数字人格');
    });

    it('更新叙事触发事件', () => {
      let payload: { narrative: string; previousNarrative: string } | undefined;
      bus.on('core:narrative-changed', (p) => { payload = p; });
      core.updateNarrative('初始叙事');
      core.updateNarrative('更新后的叙事');
      assert.equal(payload!.narrative, '更新后的叙事');
      assert.equal(payload!.previousNarrative, '初始叙事');
    });
  });

  describe('状态快照', () => {
    it('getState 返回完整状态', () => {
      core.addValue('好奇心', 0.6);
      core.addMemory('semantic', '宇宙知识', 0.5, 0.8);
      core.updateNarrative('探索世界');

      const state = core.getState();
      assert.equal(state.values.size, 1);
      assert.equal(state.memories.size, 1);
      assert.equal(state.narrative, '探索世界');
      assert.equal(state.updatedAt, 1000);
    });
  });

  describe('输入验证', () => {
    it('价值权重超出范围抛出 RangeError', () => {
      assert.throws(() => core.addValue('bad', 1.5), RangeError);
      assert.throws(() => core.addValue('bad', -0.1), RangeError);
      assert.throws(() => core.addValue('bad', NaN), RangeError);
      assert.throws(() => core.addValue('bad', Infinity), RangeError);
    });

    it('更新价值权重超出范围抛出 RangeError', () => {
      const v = core.addValue('ok', 0.5);
      assert.throws(() => core.updateValue(v.id, 2.0), RangeError);
    });

    it('记忆情感色调超出范围抛出 RangeError', () => {
      assert.throws(() => core.addMemory('episodic', 'x', 1.5, 0.5), RangeError);
      assert.throws(() => core.addMemory('episodic', 'x', -1.5, 0.5), RangeError);
    });

    it('记忆重要性超出范围抛出 RangeError', () => {
      assert.throws(() => core.addMemory('episodic', 'x', 0.5, 1.5), RangeError);
    });

    it('关联强度超出范围抛出 RangeError', () => {
      const m1 = core.addMemory('episodic', 'a', 0, 0.5);
      const m2 = core.addMemory('episodic', 'b', 0, 0.5);
      assert.throws(() => core.linkMemories(m1.id, m2.id, 'r', 2.0), RangeError);
    });
  });
});
