import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { WorkerSignalsService } from '../../workforce/worker-signals-service.js';
import type { OrgTask, TaskStatus, RiskLevel } from '../../workforce/types.js';

/* C0 enterprise 类人化隔离：worker 运行信号（mood→agent health），确定性零-LLM，per-worker 无串味。 */
describe('WorkerSignalsService（C0 worker 运行信号）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: WorkerSignalsService;
  let workerId: string;
  let otherId: string;
  let counter: number;

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'a', title: 'A', jobFamily: 'ic', seniority: 'ic', displayName: 'A', personaId: 'p-a', managerRoleCode: 'mgr' },
      { roleCode: 'b', title: 'B', jobFamily: 'ic', seniority: 'ic', displayName: 'B', personaId: 'p-b', managerRoleCode: 'mgr' },
    ];
  }

  /** 直接造一个任务（绕过 playbook，精确控制 status/risk）。 */
  function seedTask(id: string, assignee: string, status: TaskStatus, risk: RiskLevel): void {
    const t: Omit<OrgTask, 'tenantId'> = {
      id, orgId: 'org-1', goalId: 'g-1', parentTaskId: null, assignedToWorkerId: assignee,
      accountableWorkerId: 'mgr', title: id, taskType: 'x', status,
      riskLevel: risk, allowsToolExecution: false, acceptanceCriteria: 'ok', requiredCapabilities: [],
      resultSummary: null, createdAt: 1000, updatedAt: 1000,
    };
    store.insertTask(t);
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    counter = 0;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    workerId = boot.workerIdByRole.get('a')!;
    otherId = boot.workerIdByRole.get('b')!;
    svc = new WorkerSignalsService(store);
  });

  it('无任务 → idle，不需关注', () => {
    const s = svc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.load, 'idle');
    assert.equal(s.activeTaskCount, 0);
    assert.equal(s.needsAttention, false);
  });

  it('几个在手任务 → normal 负载', () => {
    seedTask('t1', workerId, 'delegated', 'low');
    seedTask('t2', workerId, 'in_progress', 'low');
    const s = svc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.activeTaskCount, 2);
    assert.equal(s.load, 'normal');
    assert.equal(s.needsAttention, false);
  });

  it('有阻塞任务 → needsAttention + heavy', () => {
    seedTask('t1', workerId, 'in_progress', 'low');
    seedTask('t2', workerId, 'blocked', 'low');
    const s = svc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.blockedTaskCount, 1);
    assert.equal(s.needsAttention, true);
    assert.equal(s.load, 'heavy', '阻塞 → heavy 需关注');
  });

  it('有高风险在手任务 → needsAttention + heavy', () => {
    seedTask('t1', workerId, 'submitted', 'high');
    const s = svc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.highRiskTaskCount, 1);
    assert.equal(s.needsAttention, true);
    assert.equal(s.load, 'heavy');
  });

  it('在手任务多（≥4）→ heavy', () => {
    for (let i = 0; i < 4; i++) seedTask(`t${i}`, workerId, 'delegated', 'low');
    assert.equal(svc.getOperatingSignal('org-1', workerId)!.load, 'heavy');
  });

  it('已交付计数（submitted/approved）', () => {
    seedTask('t1', workerId, 'approved', 'low');
    seedTask('t2', workerId, 'submitted', 'low');
    const s = svc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.deliveredTaskCount, 2);
  });

  it('确定性可复现：相同任务状态 → 相同信号', () => {
    seedTask('t1', workerId, 'blocked', 'high');
    assert.deepEqual(svc.getOperatingSignal('org-1', workerId), svc.getOperatingSignal('org-1', workerId));
  });

  it('per-worker 隔离（无串味）：A 的任务不算进 B 的信号', () => {
    seedTask('t1', workerId, 'blocked', 'high');
    const sB = svc.getOperatingSignal('org-1', otherId)!;
    assert.equal(sB.activeTaskCount, 0, 'B 的信号只看 B 自己的任务');
    assert.equal(sB.needsAttention, false);
  });

  it('worker 不存在 → undefined', () => {
    assert.equal(svc.getOperatingSignal('org-1', 'ghost'), undefined);
  });

  it('租户隔离：B 租户算不到 A 租户 worker 的信号', () => {
    seedTask('t1', workerId, 'delegated', 'low');
    const svcB = new WorkerSignalsService(new OrgWorkforceStore(db, 'tenant-b'));
    assert.equal(svcB.getOperatingSignal('org-1', workerId), undefined, 'B 租户看不到 A 的 worker');
  });
});
