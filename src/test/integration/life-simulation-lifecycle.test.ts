import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { LifeSimulationConfig } from '../../types/life-simulation.js';

describe('人生模拟生命周期集成测试', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();

    /* 准备 L0-L1 数据 */
    os.core.addValue('财务安全', 0.8);
    os.core.addValue('个人成长', 0.6);
    os.core.addValue('家庭和谐', 0.7);
    os.core.addSurvivalAnchor('收入底线', 'threshold', 50000, 3);
  });

  const CONFIG: LifeSimulationConfig = {
    horizonYears: 5,
    paths: [
      {
        id: 'stable', label: '稳定路径', description: '保持现状',
        initialConditions: { income: 300000, savings: 500000, age: 35 },
        branches: [],
      },
      {
        id: 'change', label: '转型路径', description: '职业转型',
        initialConditions: { income: 150000, savings: 400000, age: 35 },
        branches: [
          { label: '顺利', probability: 0.5, conditions: { incomeMultiplier: 1.5 } },
          { label: '坎坷', probability: 0.5, conditions: { incomeMultiplier: 0.5 } },
        ],
      },
    ],
    age: 35,
  };

  it('enqueue → executeTask → 结果完整', () => {
    const { simulationId } = os.lifeSimulation.enqueue(CONFIG, 'default');
    assert.ok(simulationId.startsWith('lsim_'));

    /* 查询状态 */
    const status = os.lifeSimulation.getStatus(simulationId);
    assert.ok(status);
    /* 执行已在 enqueue 后同步触发（service 内部） */
    assert.ok(['pending', 'running', 'completed'].includes(status.status));
  });

  it('完成后路径详情可查询', () => {
    const { simulationId } = os.lifeSimulation.enqueue(CONFIG, 'default');

    /* 手动执行 */
    os.lifeSimulation.executeTask(simulationId);

    const record = os.lifeSimulation.getStatus(simulationId);
    assert.equal(record?.status, 'completed');

    const stablePath = os.lifeSimulation.getPathDetail(simulationId, 'stable');
    assert.ok(stablePath);
    assert.equal(stablePath.pathId, 'stable');
    assert.ok(stablePath.timelineJson);
    const timeline = JSON.parse(stablePath.timelineJson!);
    assert.equal(timeline.length, 5);

    const changePath = os.lifeSimulation.getPathDetail(simulationId, 'change');
    assert.ok(changePath);
    assert.equal(changePath.pathId, 'change');
  });

  it('事件被发射', () => {
    const events: string[] = [];
    os.bus.on('life:simulation-progress', () => { events.push('progress'); });
    os.bus.on('life:path-completed', () => { events.push('path-completed'); });
    os.bus.on('life:simulation-completed', () => { events.push('completed'); });

    const { simulationId } = os.lifeSimulation.enqueue(CONFIG, 'default');
    os.lifeSimulation.executeTask(simulationId);

    assert.ok(events.includes('progress'), 'should emit progress events');
    assert.ok(events.includes('path-completed'), 'should emit path-completed events');
    assert.ok(events.includes('completed'), 'should emit completion event');
  });

  it('摘要包含推荐路径', () => {
    const { simulationId } = os.lifeSimulation.enqueue(CONFIG, 'default');
    os.lifeSimulation.executeTask(simulationId);

    const record = os.lifeSimulation.getStatus(simulationId);
    assert.ok(record?.summaryJson);
    const summary = JSON.parse(record!.summaryJson!);
    assert.ok(summary.recommendedPathId);
    assert.ok(['stable', 'change'].includes(summary.recommendedPathId));
    assert.equal(summary.paths.length, 2);
    for (const p of summary.paths) {
      assert.ok(typeof p.compositeScore === 'number');
      assert.ok(typeof p.regretProbability === 'number');
    }
  });
});
