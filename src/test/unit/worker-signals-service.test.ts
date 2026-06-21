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
      resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000,
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

  /* ── C 链 SLA 时间感知 ── */

  /** 造一个带 dueAt 的在手任务。 */
  function seedTaskDue(id: string, assignee: string, dueAt: number | null): void {
    store.insertTask({
      id, orgId: 'org-1', goalId: 'g-1', parentTaskId: null, assignedToWorkerId: assignee,
      accountableWorkerId: 'mgr', title: id, taskType: 'x', status: 'delegated',
      riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: 'ok', requiredCapabilities: [],
      resultSummary: null, dueAt, createdAt: 1000, updatedAt: 1000,
    });
  }

  it('★SLA★：now=10000，due<now → overdue；due 在 24h 内 → due_soon；远期 → 都不算', () => {
    const HOUR = 60 * 60 * 1000;
    const now = 10_000_000;
    seedTaskDue('overdue', workerId, now - HOUR);            /* 已逾期 */
    seedTaskDue('soon', workerId, now + 2 * HOUR);           /* 24h 内临期 */
    seedTaskDue('later', workerId, now + 48 * HOUR);         /* 远期，不算 */
    seedTaskDue('nodue', workerId, null);                    /* 无截止，不算 */
    const slaSvc = new WorkerSignalsService(store, () => now);
    const s = slaSvc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.overdueTaskCount, 1, '1 个逾期');
    assert.equal(s.dueSoonTaskCount, 1, '1 个临期');
    assert.equal(s.needsAttention, true, '有逾期 → 需关注');
    assert.equal(s.load, 'heavy', '逾期 → heavy');
  });

  it('★SLA★：now=0（无时钟）→ 不报逾期/临期（向后兼容）', () => {
    seedTaskDue('overdue', workerId, 100); /* 即便 due 很早 */
    const s = svc.getOperatingSignal('org-1', workerId)!; /* svc 默认 now=0 */
    assert.equal(s.overdueTaskCount, 0);
    assert.equal(s.dueSoonTaskCount, 0);
  });

  it('★SLA★：approved(已审结)不报逾期；submitted(已提交未审仍在手)**仍报逾期**', () => {
    const now = 10_000_000;
    /* approved = 已审结，离手 → 不该再报 SLA。 */
    store.insertTask({
      id: 'done', orgId: 'org-1', goalId: 'g-1', parentTaskId: null, assignedToWorkerId: workerId,
      accountableWorkerId: 'mgr', title: 'done', taskType: 'x', status: 'approved',
      riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: 'ok', requiredCapabilities: [],
      resultSummary: 'ok', dueAt: now - 999999, createdAt: 1000, updatedAt: 1000,
    });
    /* submitted = 已提交未审，仍在手（ACTIVE_STATUSES）→ 逾期仍要报（SLA 还没闭环）。 */
    store.insertTask({
      id: 'pending-review', orgId: 'org-1', goalId: 'g-1', parentTaskId: null, assignedToWorkerId: workerId,
      accountableWorkerId: 'mgr', title: 'sub', taskType: 'x', status: 'submitted',
      riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: 'ok', requiredCapabilities: [],
      resultSummary: 'draft', dueAt: now - 1, createdAt: 1000, updatedAt: 1000,
    });
    const slaSvc = new WorkerSignalsService(store, () => now);
    const s = slaSvc.getOperatingSignal('org-1', workerId)!;
    assert.equal(s.overdueTaskCount, 1, 'approved 不报、submitted(仍在手)报 → 共 1');
  });

  it('★SLA 边界★：due===now → 不逾期但算 due_soon(严格<)；due===now+24h → 不算 due_soon', () => {
    const now = 10_000_000;
    const WINDOW = 24 * 60 * 60 * 1000;
    seedTaskDue('exact-now', workerId, now);              /* due===now：< now 为 false → 不 overdue；< now+window 为 true → due_soon */
    seedTaskDue('exact-window', workerId, now + WINDOW);  /* due===now+window：< now+window 为 false → 不 due_soon */
    const slaSvc = new WorkerSignalsService(store, () => now);
    const s = slaSvc.getOperatingSignal('org-1', workerId)!;
    /* due===now 不算逾期（严格 <），算临期（< now+window）。 */
    assert.equal(s.overdueTaskCount, 0, 'due===now 不算逾期(严格<)');
    assert.equal(s.dueSoonTaskCount, 1, 'due===now 算临期；due===now+window 不算 → 共 1');
  });

  it('★SLA★：确定性——相同 now+任务 → 相同 SLA 信号', () => {
    const now = 5_000_000;
    seedTaskDue('o', workerId, now - 1);
    const a = new WorkerSignalsService(store, () => now);
    const b = new WorkerSignalsService(store, () => now);
    assert.deepEqual(a.getOperatingSignal('org-1', workerId), b.getOperatingSignal('org-1', workerId));
  });
});
