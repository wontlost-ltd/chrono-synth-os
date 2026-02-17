import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { IntegrationEngine } from '../../meta/integration-engine.js';
import { UpdateGate } from '../../meta/update-gate.js';

describe('IntegrationEngine', () => {
  let db: IDatabase;
  let clock: TestClock;
  let core: CoreRhythmLayer;
  let engine: IntegrationEngine;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    clock = new TestClock(1000);
    const bus = new EventBus();
    const logger = new SilentLogger();
    core = new CoreRhythmLayer(db, bus, clock, logger);
    engine = new IntegrationEngine(clock);
  });

  describe('propose', () => {
    it('从模拟结果生成提案', () => {
      const result = {
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([['v1', 0.7]]),
        insights: ['洞察1'], completedAt: 1000,
      };
      const proposal = engine.propose(result);
      assert.ok(proposal.id.startsWith('proposal_'));
      assert.equal(proposal.sourceVersionId, 'p1');
      assert.equal(proposal.confidence, 0.8);
      assert.equal(proposal.valueChanges.get('v1'), 0.7);
    });

    it('无洞察时 narrativeUpdate 为 undefined', () => {
      const result = {
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.5,
        valueAdjustments: new Map(), insights: [], completedAt: 1000,
      };
      const proposal = engine.propose(result);
      assert.equal(proposal.narrativeUpdate, undefined);
    });

    it('多条洞察以分号连接', () => {
      const result = {
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.5,
        valueAdjustments: new Map(),
        insights: ['洞察A', '洞察B'], completedAt: 1000,
      };
      const proposal = engine.propose(result);
      assert.equal(proposal.narrativeUpdate, '洞察A; 洞察B');
    });
  });

  describe('evaluate', () => {
    it('适应度和置信度都达标时通过', () => {
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map(), insights: [], completedAt: 1000,
      });
      assert.ok(engine.evaluate(proposal, 0.8));
    });

    it('适应度不足时拒绝', () => {
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map(), insights: [], completedAt: 1000,
      });
      assert.ok(!engine.evaluate(proposal, 0.3));
    });

    it('置信度不足时拒绝', () => {
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.3,
        valueAdjustments: new Map(), insights: [], completedAt: 1000,
      });
      assert.ok(!engine.evaluate(proposal, 0.8));
    });
  });

  describe('apply', () => {
    it('应用价值权重调整', () => {
      const v = core.addValue('诚实', 0.5);
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([[v.id, 0.7]]),
        insights: [], completedAt: 1000,
      });
      engine.apply(proposal, core);
      const updated = core.values.getAll().get(v.id);
      assert.ok(updated);
      assert.ok(updated!.weight > 0.5);
    });

    it('限制单次调整幅度（maxWeightDelta）', () => {
      const v = core.addValue('诚实', 0.5);
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([[v.id, 1.0]]),
        insights: [], completedAt: 1000,
      });
      engine.apply(proposal, core);
      const updated = core.values.getAll().get(v.id);
      assert.ok(updated);
      assert.ok(updated!.weight <= 0.6, `weight=${updated!.weight} should be <= 0.6`);
    });

    it('跳过不存在的 valueId', () => {
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([['nonexistent', 0.9]]),
        insights: [], completedAt: 1000,
      });
      engine.apply(proposal, core);
    });

    it('应用叙事更新', () => {
      core.narrative.set('初始叙事');
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map(),
        insights: ['新洞察'], completedAt: 1000,
      });
      engine.apply(proposal, core);
      const narrative = core.narrative.get();
      assert.ok(narrative.includes('新洞察'));
    });
  });

  describe('apply + UpdateGate', () => {
    it('小幅调整通过 UpdateGate 直接应用', () => {
      const v = core.addValue('诚实', 0.55);
      const gate = new UpdateGate(db, clock, { l1ConfirmationThreshold: 0.15 });
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([[v.id, 0.6]]),
        insights: [], completedAt: 1000,
      });
      const { pendingUpdates } = engine.apply(proposal, core, gate);
      assert.equal(pendingUpdates.length, 0);
      const updated = core.values.getAll().get(v.id);
      assert.ok(updated!.weight > 0.55);
    });

    it('大幅调整通过 UpdateGate 进入 pending', () => {
      const v = core.addValue('诚实', 0.5);
      const gate = new UpdateGate(db, clock, { l1ConfirmationThreshold: 0.05 });
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([[v.id, 0.7]]),
        insights: [], completedAt: 1000,
      });
      const { pendingUpdates } = engine.apply(proposal, core, gate);
      assert.ok(pendingUpdates.length > 0);
      const updated = core.values.getAll().get(v.id);
      assert.equal(updated!.weight, 0.5);
    });

    it('无 UpdateGate 时直接应用', () => {
      const v = core.addValue('诚实', 0.5);
      const proposal = engine.propose({
        scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.8,
        valueAdjustments: new Map([[v.id, 0.7]]),
        insights: [], completedAt: 1000,
      });
      const { pendingUpdates } = engine.apply(proposal, core);
      assert.equal(pendingUpdates.length, 0);
      const updated = core.values.getAll().get(v.id);
      assert.ok(updated!.weight > 0.5);
    });
  });
});
