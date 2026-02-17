import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { MetaRegulationLayer } from '../../meta/meta-regulation-layer.js';
import type { PersonaVersion } from '../../types/persona-version.js';

function makePersona(overrides: Partial<PersonaVersion> & { id: string; label: string }): PersonaVersion {
  return {
    values: new Map(),
    status: 'active',
    results: [],
    resourceQuota: 0.2,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('MetaRegulationLayer', () => {
  let db: IDatabase;
  let bus: EventBus;
  let clock: TestClock;
  let logger: SilentLogger;
  let meta: MetaRegulationLayer;
  let core: CoreRhythmLayer;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    bus = new EventBus();
    clock = new TestClock(1000);
    logger = new SilentLogger();
    meta = new MetaRegulationLayer(db, bus, clock, logger);
    core = new CoreRhythmLayer(db, bus, clock, logger);
  });

  describe('冲突检测', () => {
    it('检测价值分歧冲突', () => {
      const personas: PersonaVersion[] = [
        makePersona({ id: 'p1', label: 'A', values: new Map([['honesty', 0.9]]) }),
        makePersona({ id: 'p2', label: 'B', values: new Map([['honesty', 0.3]]) }),
      ];

      meta.detectConflicts(personas);
      const unresolved = meta.conflicts.getUnresolved();
      assert.equal(unresolved.length, 1);
      assert.equal(unresolved[0].kind, 'value_divergence');
    });

    it('不存在大分歧时不产生冲突', () => {
      const personas: PersonaVersion[] = [
        makePersona({ id: 'p1', label: 'A', values: new Map([['honesty', 0.7]]) }),
        makePersona({ id: 'p2', label: 'B', values: new Map([['honesty', 0.6]]) }),
      ];

      meta.detectConflicts(personas);
      assert.equal(meta.conflicts.getUnresolved().length, 0);
    });

    it('检测资源争用', () => {
      const personas: PersonaVersion[] = [
        makePersona({ id: 'p1', label: 'A', resourceQuota: 0.6 }),
        makePersona({ id: 'p2', label: 'B', resourceQuota: 0.6 }),
      ];

      meta.detectConflicts(personas);
      const unresolved = meta.conflicts.getUnresolved();
      const resourceConflict = unresolved.find(c => c.kind === 'resource_contention');
      assert.ok(resourceConflict);
    });
  });

  describe('冲突解决', () => {
    it('解决冲突', () => {
      const personas: PersonaVersion[] = [
        makePersona({ id: 'p1', label: 'A', values: new Map([['v', 0.9]]) }),
        makePersona({ id: 'p2', label: 'B', values: new Map([['v', 0.1]]) }),
      ];
      meta.detectConflicts(personas);

      const conflicts = meta.conflicts.getUnresolved();
      assert.equal(conflicts.length, 1);

      const resolved = meta.resolveConflict(conflicts[0].id, '采用 A 的权重');
      assert.ok(resolved);
      assert.equal(meta.conflicts.getUnresolved().length, 0);
    });
  });

  describe('资源分配', () => {
    it('等额分配', () => {
      const personas: PersonaVersion[] = [
        makePersona({ id: 'p1', label: 'A' }),
        makePersona({ id: 'p2', label: 'B' }),
      ];

      const allocations = meta.allocateResources(personas, 'equal');
      assert.equal(allocations.length, 2);
      assert.equal(allocations[0].quota, 0.5);
      assert.equal(allocations[1].quota, 0.5);
    });

    it('适应度加权分配', () => {
      const personas: PersonaVersion[] = [
        makePersona({
          id: 'p1', label: 'A',
          results: [{ scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.9, valueAdjustments: new Map(), insights: [], completedAt: 0 }],
        }),
        makePersona({
          id: 'p2', label: 'B',
          results: [{ scenarioId: 's2', personaVersionId: 'p2', fitnessScore: 0.1, valueAdjustments: new Map(), insights: [], completedAt: 0 }],
        }),
      ];

      const allocations = meta.allocateResources(personas, 'fitness_weighted');
      assert.equal(allocations.length, 2);
      /* A 的适应度高，应获得更多配额 */
      assert.ok(allocations[0].quota > allocations[1].quota);
    });

    it('不分配给非活跃人格', () => {
      const personas: PersonaVersion[] = [
        makePersona({ id: 'p1', label: 'A', status: 'paused' }),
        makePersona({ id: 'p2', label: 'B' }),
      ];

      const allocations = meta.allocateResources(personas, 'equal');
      assert.equal(allocations.length, 1);
      assert.equal(allocations[0].versionId, 'p2');
    });
  });

  describe('集成提案', () => {
    it('高适应度结果被接受', () => {
      const v = core.addValue('curiosity', 0.5);
      const result = {
        scenarioId: 's1',
        personaVersionId: 'p1',
        fitnessScore: 0.8,
        valueAdjustments: new Map([[v.id, 0.6]]),
        insights: ['发现新领域'],
        completedAt: 1000,
      };

      const proposal = meta.proposeIntegration(result);
      assert.ok(proposal.confidence >= 0.6);

      const accepted = meta.decideIntegration(proposal, result.fitnessScore, core);
      assert.ok(accepted);
    });

    it('低适应度结果被拒绝', () => {
      const result = {
        scenarioId: 's1',
        personaVersionId: 'p1',
        fitnessScore: 0.2,
        valueAdjustments: new Map<string, number>(),
        insights: [],
        completedAt: 1000,
      };

      const proposal = meta.proposeIntegration(result);
      const accepted = meta.decideIntegration(proposal, result.fitnessScore, core);
      assert.ok(!accepted);
    });
  });
});
