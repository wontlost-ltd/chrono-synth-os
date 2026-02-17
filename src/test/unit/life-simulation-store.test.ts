import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { LifeSimulationStore } from '../../storage/life-simulation-store.js';
import type { LifeSimulationConfig, LifePathResult } from '../../types/life-simulation.js';

const CONFIG: LifeSimulationConfig = {
  horizonYears: 5,
  paths: [
    { id: 'a', label: 'A', description: '', initialConditions: {}, branches: [] },
    { id: 'b', label: 'B', description: '', initialConditions: {}, branches: [] },
  ],
};

const PATH_RESULT: LifePathResult = {
  pathId: 'a',
  label: 'A',
  timeline: [
    {
      year: 1, wealth: 500000,
      emotionalState: { valence: 0.3, stress: 0.3, fulfillment: 0.5, regret: 0.1 },
      familyState: { spouseSecurity: 0.8, childCost: 50000, familyPressure: 0.2 },
      healthIndex: 0.95, overallScore: 0.7, valueWeights: { v1: 0.8 },
    },
  ],
  branches: [],
  compositeScore: 0.72,
  regretProbability: 0.28,
};

describe('LifeSimulationStore', () => {
  let db: IDatabase;
  let store: LifeSimulationStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    store = new LifeSimulationStore(db);
  });

  it('create + getById', () => {
    store.create('sim1', 'tenant1', 'task1', CONFIG);
    const record = store.getById('sim1');
    assert.ok(record);
    assert.equal(record.id, 'sim1');
    assert.equal(record.tenantId, 'tenant1');
    assert.equal(record.taskId, 'task1');
    assert.equal(record.status, 'pending');
    assert.equal(record.error, null);
  });

  it('setStatus 更新状态', () => {
    store.create('sim2', 'default', 'task2', CONFIG);
    store.setStatus('sim2', 'running');
    let record = store.getById('sim2');
    assert.equal(record?.status, 'running');

    store.setStatus('sim2', 'completed');
    record = store.getById('sim2');
    assert.equal(record?.status, 'completed');
    assert.ok(record!.completedAt! > 0);
  });

  it('setStatus 记录错误信息', () => {
    store.create('sim3', 'default', 'task3', CONFIG);
    store.setStatus('sim3', 'failed', '模拟失败');
    const record = store.getById('sim3');
    assert.equal(record?.status, 'failed');
    assert.equal(record?.error, '模拟失败');
  });

  it('updateProgress + 查询', () => {
    store.create('sim4', 'default', 'task4', CONFIG);
    store.updateProgress('sim4', { percent: 50, stage: 'year_5' });
    const record = store.getById('sim4');
    assert.ok(record?.progressJson);
    const progress = JSON.parse(record!.progressJson!);
    assert.equal(progress.percent, 50);
  });

  it('savePathResult + getPathDetail', () => {
    store.create('sim5', 'default', 'task5', CONFIG);
    store.savePathResult('sim5', PATH_RESULT);
    const pathRecord = store.getPathDetail('sim5', 'a');
    assert.ok(pathRecord);
    assert.equal(pathRecord.pathId, 'a');
    assert.equal(pathRecord.label, 'A');
    assert.equal(pathRecord.status, 'completed');
    assert.ok(pathRecord.timelineJson);
    const timeline = JSON.parse(pathRecord.timelineJson!);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].year, 1);
  });

  it('getByTenant 按创建时间降序', () => {
    store.create('sim_a', 'tenant_x', 'ta', CONFIG);
    store.create('sim_b', 'tenant_x', 'tb', CONFIG);
    store.create('sim_c', 'tenant_y', 'tc', CONFIG);
    const results = store.getByTenant('tenant_x');
    assert.equal(results.length, 2);
    assert.ok(results[0].createdAt >= results[1].createdAt);
  });
});
