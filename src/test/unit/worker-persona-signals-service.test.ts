import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { WorkerCollaborationMemoryStore } from '../../storage/worker-collaboration-memory-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { WorkerSignalsService } from '../../workforce/worker-signals-service.js';
import { WorkerPersonaSignalsService } from '../../workforce/worker-persona-signals-service.js';
import type { OrgTask, TaskStatus, RiskLevel } from '../../workforce/types.js';

/* C2 worker 人格信号束：stance→决策置信度 / relationship→协作广度 / proactive→主动汇报。确定性零-LLM。 */
describe('WorkerPersonaSignalsService（C2 worker 人格信号）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let collab: WorkerCollaborationMemoryStore;
  let svc: WorkerPersonaSignalsService;
  let workerId: string;
  let counter: number;

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'a', title: 'A', jobFamily: 'ic', seniority: 'ic', displayName: 'A', personaId: 'p-a', managerRoleCode: 'mgr' },
    ];
  }

  function seedTask(id: string, status: TaskStatus, risk: RiskLevel): void {
    const t: Omit<OrgTask, 'tenantId'> = {
      id, orgId: 'org-1', goalId: 'g', parentTaskId: null, assignedToWorkerId: workerId,
      accountableWorkerId: 'mgr', title: id, taskType: 'x', status,
      riskLevel: risk, allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [],
      resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000,
    };
    store.insertTask(t);
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    collab = new WorkerCollaborationMemoryStore(db, 'tenant-a');
    counter = 0;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    workerId = boot.workerIdByRole.get('a')!;
    svc = new WorkerPersonaSignalsService(new WorkerSignalsService(store), collab);
  });

  it('稳定交付（≥3）无阻塞高风险 → high 置信度，不需汇报', () => {
    seedTask('t1', 'approved', 'low');
    seedTask('t2', 'approved', 'low');
    seedTask('t3', 'submitted', 'low');
    const s = svc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.decisionConfidence, 'high');
    assert.match(s.confidenceRationale, /稳定交付/);
    assert.equal(s.shouldReport, false);
  });

  it('有阻塞 → low 置信度 + 该主动汇报（proactive）', () => {
    seedTask('t1', 'blocked', 'low');
    const s = svc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.decisionConfidence, 'low');
    assert.match(s.confidenceRationale, /阻塞/);
    assert.equal(s.shouldReport, true, '有阻塞该主动汇报');
  });

  it('有高风险在手 → low 置信度 + 该主动汇报', () => {
    seedTask('t1', 'submitted', 'high');
    const s = svc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.decisionConfidence, 'low');
    assert.match(s.confidenceRationale, /高风险/);
    assert.equal(s.shouldReport, true);
  });

  it('交付记录浅但干净 → medium 置信度', () => {
    seedTask('t1', 'approved', 'low');
    const s = svc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.decisionConfidence, 'medium');
  });

  it('★SLA★：只有逾期（无阻塞无高风险）→ low + 该汇报，依据是逾期不是「0 个高风险」（Codex 复审）', () => {
    const now = 10_000_000;
    /* 一个在手且已逾期的 low 风险任务（无阻塞、无高风险）。 */
    store.insertTask({
      id: 'overdue', orgId: 'org-1', goalId: 'g', parentTaskId: null, assignedToWorkerId: workerId,
      accountableWorkerId: 'mgr', title: 'overdue', taskType: 'x', status: 'delegated',
      riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [],
      resultSummary: null, dueAt: now - 1, createdAt: 1000, updatedAt: 1000,
    });
    /* persona-signals 用带真实时钟的 signal service。 */
    const slaSvc = new WorkerPersonaSignalsService(new WorkerSignalsService(store, () => now), collab);
    const s = slaSvc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.decisionConfidence, 'low');
    assert.equal(s.shouldReport, true, '逾期该主动汇报');
    assert.match(s.confidenceRationale, /逾期/, '依据是逾期');
    assert.doesNotMatch(s.confidenceRationale, /0 个高风险/, '不再错报「0 个高风险」');
  });

  it('协作广度（relationship→reach）：协作过 3 个不同对手方 → reach=3，无串味', () => {
    collab.recordCollaboration('org-1', workerId, 'worker', 'alice', 1000);
    collab.recordCollaboration('org-1', workerId, 'worker', 'bob', 1000);
    collab.recordCollaboration('org-1', workerId, 'team', 'support', 1000);
    const s = svc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.collaborationReach, 3);
  });

  it('确定性可复现：相同状态 → 相同人格信号', () => {
    seedTask('t1', 'blocked', 'high');
    collab.recordCollaboration('org-1', workerId, 'worker', 'x', 1000);
    assert.deepEqual(svc.getPersonaSignal('org-1', workerId), svc.getPersonaSignal('org-1', workerId));
  });

  it('透传底层 C0 运行信号', () => {
    seedTask('t1', 'in_progress', 'low');
    const s = svc.getPersonaSignal('org-1', workerId)!;
    assert.equal(s.operating.activeTaskCount, 1);
    assert.ok(['idle', 'normal', 'heavy'].includes(s.operating.load));
  });

  it('worker 不存在 → undefined', () => {
    assert.equal(svc.getPersonaSignal('org-1', 'ghost'), undefined);
  });

  it('信号是企业语言（决策置信度/协作广度/汇报标记），不是「心情/迟疑表演」', () => {
    const s = svc.getPersonaSignal('org-1', workerId)!;
    /* 字段都是运营语言；无 mood/valence/arousal/hesitation 等情绪表演字段。 */
    assert.ok('decisionConfidence' in s && 'collaborationReach' in s && 'shouldReport' in s);
    assert.ok(!('mood' in s) && !('valence' in s));
  });
});
