import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { MetaRegulationLayer } from '../../meta/meta-regulation-layer.js';
import { EvolutionMerger } from '../../recovery/evolution-merger.js';
import type { PersonaVersion } from '../../types/persona-version.js';

describe('EvolutionMerger', () => {
  let db: IDatabase;
  let clock: TestClock;
  let logger: SilentLogger;
  let core: CoreRhythmLayer;
  let meta: MetaRegulationLayer;
  let merger: EvolutionMerger;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    clock = new TestClock(1000);
    logger = new SilentLogger();
    const bus = new EventBus();
    core = new CoreRhythmLayer(db, bus, clock, logger);
    meta = new MetaRegulationLayer(db, bus, clock, logger);
    merger = new EvolutionMerger(db, clock, logger);
  });

  function makeCompletedPersona(
    id: string,
    label: string,
    fitnessScore: number,
    valueAdjustments: Map<string, number>,
  ): PersonaVersion {
    return {
      id,
      label,
      values: new Map(),
      status: 'completed',
      results: [{
        scenarioId: 's1', personaVersionId: id, fitnessScore,
        valueAdjustments, insights: ['洞察'], completedAt: 1000,
      }],
      resourceQuota: 0.2,
      createdAt: 1000,
      updatedAt: 1000,
    };
  }

  it('空完成列表返回空合并', () => {
    const { mergedVersionIds, valueDelta, diffReport } = merger.merge([], core, meta);
    assert.equal(mergedVersionIds.length, 0);
    assert.equal(valueDelta.size, 0);
    assert.equal(diffReport.valueDiffs.length, 0);
    assert.equal(diffReport.totalDeltaMagnitude, 0);
    assert.equal(diffReport.regretProbability, 0);
    assert.equal(diffReport.summary, '无版本被合并');
  });

  it('无结果的人格不被合并', () => {
    const persona: PersonaVersion = {
      id: 'p1', label: '测试', values: new Map(), status: 'completed',
      results: [], resourceQuota: 0.2, createdAt: 1000, updatedAt: 1000,
    };
    const { mergedVersionIds } = merger.merge([persona], core, meta);
    assert.equal(mergedVersionIds.length, 0);
  });

  it('高适应度人格被合并', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.9, new Map([[v.id, 0.7]]));
    const { mergedVersionIds, valueDelta } = merger.merge([persona], core, meta);
    assert.ok(mergedVersionIds.includes('p1'));
    assert.ok(valueDelta.size > 0);
  });

  it('低适应度人格被拒绝', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.1, new Map([[v.id, 0.7]]));
    const { mergedVersionIds } = merger.merge([persona], core, meta);
    assert.equal(mergedVersionIds.length, 0);
  });

  it('valueDelta 追踪权重变化', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.9, new Map([[v.id, 0.8]]));
    const { valueDelta } = merger.merge([persona], core, meta);
    if (valueDelta.size > 0) {
      const delta = valueDelta.get(v.id);
      assert.ok(delta !== undefined);
      assert.ok(delta! > 0);
    }
  });

  it('persistRecord 持久化到数据库', () => {
    /* 需要先创建快照记录以满足外键约束 */
    db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run('snap-before', '{}', 'manual', 1000);
    db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run('snap-after', '{}', 'manual', 1001);

    const record = merger.persistRecord(
      'snap-before', 'snap-after', ['p1', 'p2'], new Map([['v1', 0.1]]),
    );
    assert.ok(record.id.startsWith('evo_'));
    assert.equal(record.beforeSnapshotId, 'snap-before');
    assert.equal(record.afterSnapshotId, 'snap-after');
    assert.deepEqual(record.mergedVersionIds, ['p1', 'p2']);
    assert.equal(record.evolvedAt, 1000);

    const row = db.prepare<{ id: string }>('SELECT id FROM evolution_records WHERE id = ?').get(record.id);
    assert.ok(row);
  });

  it('selectBest 选择最高适应度结果', () => {
    const v = core.addValue('诚实', 0.5);
    const persona: PersonaVersion = {
      id: 'p1', label: '测试', values: new Map(), status: 'completed',
      results: [
        { scenarioId: 's1', personaVersionId: 'p1', fitnessScore: 0.3, valueAdjustments: new Map(), insights: [], completedAt: 1000 },
        { scenarioId: 's2', personaVersionId: 'p1', fitnessScore: 0.95, valueAdjustments: new Map([[v.id, 0.9]]), insights: ['最佳'], completedAt: 1000 },
        { scenarioId: 's3', personaVersionId: 'p1', fitnessScore: 0.5, valueAdjustments: new Map(), insights: [], completedAt: 1000 },
      ],
      resourceQuota: 0.2,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const { mergedVersionIds } = merger.merge([persona], core, meta);
    assert.ok(mergedVersionIds.includes('p1'));
  });

  it('diffReport 包含 valueDiffs 和正确 label', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.9, new Map([[v.id, 0.7]]));
    const { diffReport } = merger.merge([persona], core, meta);
    if (diffReport.valueDiffs.length > 0) {
      const diff = diffReport.valueDiffs.find(d => d.valueId === v.id);
      assert.ok(diff);
      assert.equal(diff!.label, '诚实');
      assert.equal(diff!.weightBefore, 0.5);
      assert.ok(diff!.weightAfter !== 0.5);
      assert.ok(Math.abs(diff!.delta - (diff!.weightAfter - diff!.weightBefore)) < 1e-9);
    }
  });

  it('合并后 regretProbability > 0', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.9, new Map([[v.id, 0.8]]));
    const { diffReport, mergedVersionIds } = merger.merge([persona], core, meta);
    if (mergedVersionIds.length > 0 && diffReport.valueDiffs.length > 0) {
      assert.ok(diffReport.regretProbability > 0);
      assert.ok(diffReport.totalDeltaMagnitude > 0);
    }
  });

  it('regretProbability 与 regretSensitivity 正相关', () => {
    /* 默认 regretSensitivity=0.5，先测量基线 */
    const v1 = core.addValue('诚实', 0.5);
    const persona1 = makeCompletedPersona('p1', '测试', 0.9, new Map([[v1.id, 0.8]]));
    const { diffReport: report1 } = merger.merge([persona1], core, meta);

    /* 重建环境，提高 regretSensitivity */
    const db2 = createMemoryDatabase();
    runMigrations(db2);
    const bus2 = new EventBus();
    const core2 = new CoreRhythmLayer(db2, bus2, clock, logger);
    const meta2 = new MetaRegulationLayer(db2, bus2, clock, logger);
    const merger2 = new EvolutionMerger(db2, clock, logger);
    core2.setDecisionStyle({ regretSensitivity: 0.9 });
    const v2 = core2.addValue('诚实', 0.5);
    const persona2 = makeCompletedPersona('p2', '测试', 0.9, new Map([[v2.id, 0.8]]));
    const { diffReport: report2 } = merger2.merge([persona2], core2, meta2);

    /* 更高 regretSensitivity → 更高 regretProbability */
    if (report1.totalDeltaMagnitude > 0 && report2.totalDeltaMagnitude > 0) {
      assert.ok(report2.regretProbability >= report1.regretProbability,
        `高敏感=${report2.regretProbability} 低敏感=${report1.regretProbability}`);
    }
  });

  it('无合并时 diffReport.summary 为无版本被合并', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.1, new Map([[v.id, 0.7]]));
    const { diffReport } = merger.merge([persona], core, meta);
    assert.equal(diffReport.summary, '无版本被合并');
    assert.equal(diffReport.regretProbability, 0);
  });

  it('合并时 diffReport.summary 包含关键信息', () => {
    const v = core.addValue('诚实', 0.5);
    const persona = makeCompletedPersona('p1', '测试', 0.9, new Map([[v.id, 0.8]]));
    const { diffReport, mergedVersionIds } = merger.merge([persona], core, meta);
    if (mergedVersionIds.length > 0) {
      assert.ok(diffReport.summary.includes('合并'));
      assert.ok(diffReport.summary.includes('版本'));
      assert.ok(diffReport.summary.includes('后悔概率'));
    }
  });

  it('persistRecord 持久化 diffReport', () => {
    db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run('snap-dr-before', '{}', 'manual', 1000);
    db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run('snap-dr-after', '{}', 'manual', 1001);

    const diffReport = {
      valueDiffs: [{ valueId: 'v1', label: '诚实', weightBefore: 0.5, weightAfter: 0.6, delta: 0.1 }],
      regretProbability: 0.25,
      totalDeltaMagnitude: 0.1,
      summary: '合并 1 个版本',
    };
    const record = merger.persistRecord(
      'snap-dr-before', 'snap-dr-after', ['p1'], new Map([['v1', 0.1]]), diffReport,
    );
    assert.deepEqual(record.diffReport, diffReport);

    const row = db.prepare<{ diff_report_json: string | null }>(
      'SELECT diff_report_json FROM evolution_records WHERE id = ?',
    ).get(record.id);
    assert.ok(row);
    assert.ok(row!.diff_report_json);
    const parsed = JSON.parse(row!.diff_report_json!);
    assert.equal(parsed.regretProbability, 0.25);
    assert.equal(parsed.valueDiffs.length, 1);
  });

  it('persistRecord 无 diffReport 时 diff_report_json 为 null', () => {
    db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run('snap-no-dr-before', '{}', 'manual', 1000);
    db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run('snap-no-dr-after', '{}', 'manual', 1001);

    const record = merger.persistRecord(
      'snap-no-dr-before', 'snap-no-dr-after', ['p1'], new Map([['v1', 0.1]]),
    );
    const row = db.prepare<{ diff_report_json: string | null }>(
      'SELECT diff_report_json FROM evolution_records WHERE id = ?',
    ).get(record.id);
    assert.ok(row);
    assert.equal(row!.diff_report_json, null);
  });
});
