import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { AcceleratedLayer } from '../../accelerated/accelerated-layer.js';
import { SimulationRunner } from '../../accelerated/simulation-runner.js';

describe('AcceleratedLayer', () => {
  let db: IDatabase;
  let bus: EventBus;
  let clock: TestClock;
  let logger: SilentLogger;
  let layer: AcceleratedLayer;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    bus = new EventBus();
    clock = new TestClock(1000);
    logger = new SilentLogger();
    layer = new AcceleratedLayer(db, bus, clock, logger);
  });

  describe('人格版本管理', () => {
    it('从核心价值分叉创建人格', () => {
      const values = new Map([['v1', 0.8], ['v2', 0.6]]);
      const persona = layer.forkPersona('测试版本A', values, 0.3);
      assert.equal(persona.label, '测试版本A');
      assert.equal(persona.status, 'active');
      assert.equal(persona.resourceQuota, 0.3);
      assert.deepEqual(persona.values, values);
    });

    it('创建人格触发事件', () => {
      let emitted = false;
      bus.on('persona:created', () => { emitted = true; });
      layer.forkPersona('A', new Map(), 0.2);
      assert.ok(emitted);
    });

    it('暂停和恢复人格', () => {
      const p = layer.forkPersona('B', new Map(), 0.2);
      assert.ok(layer.pausePersona(p.id));

      const paused = layer.personas.getById(p.id);
      assert.equal(paused!.status, 'paused');

      assert.ok(layer.resumePersona(p.id));
      const resumed = layer.personas.getById(p.id);
      assert.equal(resumed!.status, 'active');
    });

    it('完成人格', () => {
      const p = layer.forkPersona('C', new Map(), 0.2);
      assert.ok(layer.completePersona(p.id));
      const completed = layer.personas.getById(p.id);
      assert.equal(completed!.status, 'completed');
    });

    it('getActivePersonas 只返回活跃版本', () => {
      layer.forkPersona('A', new Map(), 0.2);
      const b = layer.forkPersona('B', new Map(), 0.2);
      layer.pausePersona(b.id);

      const actives = layer.getActivePersonas();
      assert.equal(actives.length, 1);
      assert.equal(actives[0].label, 'A');
    });
  });

  describe('输入验证', () => {
    it('资源配额超出范围抛出 RangeError', () => {
      assert.throws(() => layer.forkPersona('bad', new Map(), 1.5), RangeError);
      assert.throws(() => layer.forkPersona('bad', new Map(), -0.1), RangeError);
      assert.throws(() => layer.forkPersona('bad', new Map(), NaN), RangeError);
      assert.throws(() => layer.forkPersona('bad', new Map(), Infinity), RangeError);
    });
  });

  describe('模拟运行', () => {
    it('运行模拟并记录结果', () => {
      const values = new Map([['curiosity', 0.9]]);
      const persona = layer.forkPersona('Explorer', values, 0.5);

      const scenario = SimulationRunner.createScenario(
        '探索未知领域',
        new Map([['curiosity', 1.0]]),
      );

      const result = layer.runSimulation(persona.id, scenario);
      assert.ok(result.fitnessScore >= 0);
      assert.ok(result.fitnessScore <= 1);
      assert.equal(result.personaVersionId, persona.id);

      /* 确认结果已记录到人格版本 */
      const updated = layer.personas.getById(persona.id);
      assert.equal(updated!.results.length, 1);
    });

    it('模拟完成触发事件', () => {
      let emitted = false;
      bus.on('persona:simulation-completed', () => { emitted = true; });

      const p = layer.forkPersona('D', new Map([['a', 0.5]]), 0.2);
      const scenario = SimulationRunner.createScenario('test', new Map());
      layer.runSimulation(p.id, scenario);
      assert.ok(emitted);
    });

    it('对不存在的人格运行模拟抛出错误', () => {
      const scenario = SimulationRunner.createScenario('test', new Map());
      assert.throws(() => layer.runSimulation('nonexistent', scenario));
    });

    it('评估器输出越界时自动夹紧到 0-1', () => {
      const badEvaluator = () => ({
        fitnessScore: 2.5,
        valueAdjustments: new Map([['x', -3.0]]),
        insights: [],
      });
      const badLayer = new AcceleratedLayer(db, bus, clock, logger, badEvaluator);
      const p = badLayer.forkPersona('X', new Map([['x', 0.5]]), 0.3);
      const scenario = SimulationRunner.createScenario('test', new Map());
      const result = badLayer.runSimulation(p.id, scenario);
      assert.equal(result.fitnessScore, 1);
      assert.equal(result.valueAdjustments.get('x'), 0);
    });

    it('评估器输出 NaN/Infinity 归零', () => {
      const nanEvaluator = () => ({
        fitnessScore: NaN,
        valueAdjustments: new Map([['x', Infinity]]),
        insights: [],
      });
      const nanLayer = new AcceleratedLayer(db, bus, clock, logger, nanEvaluator);
      const p = nanLayer.forkPersona('Y', new Map([['x', 0.5]]), 0.3);
      const scenario = SimulationRunner.createScenario('test', new Map());
      const result = nanLayer.runSimulation(p.id, scenario);
      assert.equal(result.fitnessScore, 0);
      assert.equal(result.valueAdjustments.get('x'), 0);
    });

    it('runOnAllActive 在所有活跃人格上运行', () => {
      layer.forkPersona('A', new Map([['x', 0.5]]), 0.2);
      layer.forkPersona('B', new Map([['x', 0.7]]), 0.2);
      const c = layer.forkPersona('C', new Map([['x', 0.3]]), 0.2);
      layer.pausePersona(c.id);

      const scenario = SimulationRunner.createScenario('batch', new Map());
      const results = layer.runOnAllActive(scenario);
      assert.equal(results.length, 2);
    });
  });
});
