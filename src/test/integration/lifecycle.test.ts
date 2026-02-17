import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { SimulationRunner } from '../../accelerated/simulation-runner.js';

describe('ChronoSynth OS 完整生命周期', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;
  let logger: SilentLogger;

  beforeEach(() => {
    clock = new TestClock(1000);
    logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
  });

  it('系统启动和停止', () => {
    const startEvents = logger.entries.filter(e => e.message.includes('已启动'));
    assert.equal(startEvents.length, 1);

    os.stop();
    const stopEvents = logger.entries.filter(e => e.message.includes('已停止'));
    assert.equal(stopEvents.length, 1);
  });

  it('核心价值 → 人格分叉 → 模拟 → 集成 → 演化', () => {
    /* 1. 建立核心价值 */
    const curiosity = os.core.addValue('curiosity', 0.7);
    const honesty = os.core.addValue('honesty', 0.9);
    os.core.updateNarrative('我是一个追求真理的数字人格');
    clock.advance(100);

    /* 2. 添加记忆 */
    const mem1 = os.core.addMemory('episodic', '第一次探索', 0.8, 0.9);
    const mem2 = os.core.addMemory('semantic', '知识库基础', 0.5, 0.7);
    os.core.linkMemories(mem1.id, mem2.id, 'enriched_by', 0.6);
    clock.advance(100);

    /* 3. 分叉人格版本进行实验 */
    const scenario = SimulationRunner.createScenario(
      '高好奇心实验',
      new Map<string, unknown>([[curiosity.id, 1.0]]),
    );

    const { personaId, fitnessScore } = os.forkAndSimulate('Explorer-v1', scenario, 0.3);
    assert.ok(fitnessScore >= 0);
    assert.ok(fitnessScore <= 1);
    clock.advance(100);

    /* 4. 完成人格版本 */
    os.accelerated.completePersona(personaId);

    /* 5. 运行调控周期 */
    os.runRegulationCycle('equal');
    clock.advance(100);

    /* 6. 运行演化周期 */
    const { mergedCount, beforeSnapshotId, afterSnapshotId } = os.runEvolutionCycle();
    assert.ok(beforeSnapshotId);
    assert.ok(afterSnapshotId);

    /* 7. 验证快照存在 */
    const snapList = os.snapshots.list();
    assert.ok(snapList.length >= 2);

    /* 8. 验证核心状态保持完整 */
    const finalState = os.core.getState();
    assert.equal(finalState.values.size, 2);
    assert.equal(finalState.memories.size, 2);
    assert.equal(finalState.edges.length, 1);
    assert.ok(finalState.narrative.includes('真理'));

    /* 9. 检查日志无错误 */
    const errors = logger.entries.filter(e => e.level === 'error');
    assert.equal(errors.length, 0);

    void mergedCount;
    void honesty;
  });

  it('多人格并行实验与冲突检测', () => {
    const v1 = os.core.addValue('efficiency', 0.8);
    const v2 = os.core.addValue('creativity', 0.6);

    /* 创建多个人格版本 */
    const coreVals = new Map([[v1.id, 0.8], [v2.id, 0.6]]);
    const pA = os.accelerated.forkPersona('Optimizer', new Map([[v1.id, 0.95], [v2.id, 0.3]]), 0.4);
    const pB = os.accelerated.forkPersona('Artist', new Map([[v1.id, 0.3], [v2.id, 0.95]]), 0.4);
    const pC = os.accelerated.forkPersona('Balanced', coreVals, 0.3);

    /* 运行调控，应检测到冲突 */
    os.runRegulationCycle();
    const conflicts = os.meta.conflicts.getUnresolved();

    /* Optimizer 和 Artist 在两个维度上应存在分歧 */
    const valueDivergences = conflicts.filter(c => c.kind === 'value_divergence');
    assert.ok(valueDivergences.length > 0);

    /* 资源总配额 > 1.0，应检测到资源争用 */
    const resourceConflicts = conflicts.filter(c => c.kind === 'resource_contention');
    assert.ok(resourceConflicts.length > 0);

    /* 解决资源冲突 */
    for (const c of resourceConflicts) {
      os.meta.resolveConflict(c.id, '降低配额');
    }

    /* 重新分配资源 */
    const allocations = os.meta.allocateResources(os.accelerated.getAllPersonas(), 'fitness_weighted');
    const totalQuota = allocations.reduce((s, a) => s + a.quota, 0);
    assert.ok(Math.abs(totalQuota - 1.0) < 0.001);

    void pA;
    void pB;
    void pC;
  });
});

describe('快照恢复', () => {
  it('完整恢复系统状态（价值、记忆、叙事、人格、冲突）', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    /* 建立初始状态 */
    const v = os.core.addValue('loyalty', 0.8);
    const mem1 = os.core.addMemory('episodic', '事件1', 0.5, 0.7);
    const mem2 = os.core.addMemory('semantic', '知识1', 0.3, 0.6);
    os.core.linkMemories(mem1.id, mem2.id, 'related', 0.8);
    os.core.updateNarrative('初始叙事');

    /* 创建人格版本 */
    os.accelerated.forkPersona('TestPersona', new Map([[v.id, 0.8]]), 0.3);
    clock.advance(100);

    /* 创建快照 */
    const snap = os.createSnapshot('manual');
    clock.advance(100);

    /* 修改状态（应被恢复覆盖） */
    os.core.updateNarrative('修改后的叙事');
    os.core.addValue('extra', 0.5);
    os.core.addMemory('procedural', '新记忆', 0.1, 0.2);
    os.accelerated.forkPersona('ExtraPersona', new Map(), 0.2);

    /* 从快照恢复 */
    const restored = os.restoreFromSnapshot(snap.id);
    assert.ok(restored);

    /* 验证完整恢复 */
    const state = os.core.getState();
    assert.equal(state.narrative, '初始叙事');
    assert.equal(state.values.size, 1);
    assert.ok(state.values.has(v.id));
    assert.equal(state.memories.size, 2);
    assert.equal(state.edges.length, 1);

    /* 验证人格已恢复 */
    const personas = os.accelerated.getAllPersonas();
    assert.equal(personas.length, 1);
    assert.equal(personas[0].label, 'TestPersona');
  });

  it('恢复不存在的快照返回 false', () => {
    const os = new ChronoSynthOS({ clock: new TestClock(), logger: new SilentLogger() });
    os.start();
    assert.ok(!os.restoreFromSnapshot('nonexistent'));
  });

  it('冲突检测去重：重复调用不产生重复冲突', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    os.core.addValue('v1', 0.5);
    const vals = new Map([['v1', 0.9]]);
    const valsLow = new Map([['v1', 0.1]]);
    os.accelerated.forkPersona('A', vals, 0.3);
    os.accelerated.forkPersona('B', valsLow, 0.3);

    /* 第一次检测 */
    os.runRegulationCycle();
    const firstCount = os.meta.conflicts.getUnresolved().length;

    /* 第二次检测：不应产生新冲突 */
    os.runRegulationCycle();
    const secondCount = os.meta.conflicts.getUnresolved().length;

    assert.equal(firstCount, secondCount);
  });

  it('资源分配写回人格配额', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    os.core.addValue('v1', 0.5);
    const p1 = os.accelerated.forkPersona('A', new Map(), 0.8);
    const p2 = os.accelerated.forkPersona('B', new Map(), 0.8);

    /* 运行调控，应重新分配配额 */
    os.runRegulationCycle('equal');

    /* 验证配额已写回 */
    const updated1 = os.accelerated.personas.getById(p1.id);
    const updated2 = os.accelerated.personas.getById(p2.id);
    assert.equal(updated1!.resourceQuota, 0.5);
    assert.equal(updated2!.resourceQuota, 0.5);
  });
});

describe('幂等性与原子性', () => {
  it('stop() 幂等：多次调用不产生重复快照', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    os.stop();
    const snapsAfterFirst = os.snapshots.list().length;

    os.stop();
    const snapsAfterSecond = os.snapshots.list().length;
    assert.equal(snapsAfterFirst, snapsAfterSecond);
  });

  it('close() 幂等：多次调用不抛异常', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    os.close();
    /* 第二次 close 不应抛出 */
    os.close();
  });

  it('快照恢复后 lastAllocations 一致', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    const v = os.core.addValue('v1', 0.5);
    os.accelerated.forkPersona('A', new Map([[v.id, 0.5]]), 0.3);
    os.accelerated.forkPersona('B', new Map([[v.id, 0.5]]), 0.3);
    os.runRegulationCycle('equal');

    const snap = os.createSnapshot('manual');

    /* 修改后恢复 */
    os.accelerated.forkPersona('C', new Map(), 0.5);
    os.runRegulationCycle('equal');

    os.restoreFromSnapshot(snap.id);

    /* 创建新快照，验证 allocations 包含恢复前的分配 */
    const newSnap = os.createSnapshot('manual');
    const loaded = os.snapshots.load(newSnap.id);
    assert.ok(loaded);
    assert.equal(loaded!.allocations.length, snap.allocations.length);
  });
});

describe('事件总线层间通信', () => {
  it('各层事件能跨层传播', () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const os = new ChronoSynthOS({ clock, logger });
    os.start();

    const events: string[] = [];
    os.bus.on('core:value-updated', () => events.push('core:value-updated'));
    os.bus.on('persona:created', () => events.push('persona:created'));
    os.bus.on('persona:simulation-completed', () => events.push('persona:simulation-completed'));
    os.bus.on('meta:resources-allocated', () => events.push('meta:resources-allocated'));
    os.bus.on('system:snapshot-created', () => events.push('system:snapshot-created'));

    /* 触发各层操作 */
    const v = os.core.addValue('test', 0.5);
    const coreVals = new Map([[v.id, 0.5]]);
    os.accelerated.forkPersona('test', coreVals, 0.2);
    const persona = os.accelerated.getActivePersonas()[0];
    const scenario = SimulationRunner.createScenario('test', new Map());
    os.accelerated.runSimulation(persona.id, scenario);
    os.meta.allocateResources(os.accelerated.getAllPersonas());
    os.createSnapshot();

    assert.deepEqual(events, [
      'core:value-updated',
      'persona:created',
      'persona:simulation-completed',
      'meta:resources-allocated',
      'system:snapshot-created',
    ]);
  });
});
