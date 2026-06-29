/**
 * 组织重组/并购 service 集成测试——锁住确定性结构操作 + 不变量守卫。
 *
 * reparent：改汇报线 / 不成环 / 新上级须 active；offboard：软删 / 非根 / 下属先安置 / 在手任务先重分配；
 * absorb：12 表 org_id 迁移 / roleCode 冲突加后缀 / B 根接 A 挂载点 / A 单根不变 / 原子。全零-LLM 确定性。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec, InvalidOrgChartError } from '../../workforce/org-chart-service.js';
import { OrgRestructureService } from '../../workforce/org-restructure-service.js';

describe('OrgRestructureService（吸收 / reparent / offboard，确定性 + 不变量守卫）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: OrgRestructureService;
  let clock: number;
  let counter: number;

  /** 标准三层组织：CEO → mgr → ic（id 由 bootstrap 返回）。 */
  function pod(prefix: string): WorkerSpec[] {
    return [
      { roleCode: 'ceo', title: 'CEO', jobFamily: 'exec', seniority: 'exec', displayName: `${prefix}-CEO`, personaId: `p-${prefix}-ceo`, managerRoleCode: null },
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: `${prefix}-MGR`, personaId: `p-${prefix}-mgr`, managerRoleCode: 'ceo' },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: `${prefix}-IC`, personaId: `p-${prefix}-ic`, managerRoleCode: 'mgr' },
    ];
  }
  function bootstrap(orgId: string, prefix: string): Map<string, string> {
    const chart = new OrgChartService(store, () => clock, () => `${orgId}-id-${++counter}`);
    return new Map(chart.bootstrap(orgId, pod(prefix)).workerIdByRole);
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    svc = new OrgRestructureService(store, () => clock);
    clock = 1000; counter = 0;
  });

  /* ── reparent ── */

  it('★reparent：IC 从 mgr 改挂到 CEO 下★', () => {
    const a = bootstrap('A', 'A');
    svc.reparent({ orgId: 'A', workerId: a.get('ic')!, newManagerWorkerId: a.get('ceo')! });
    assert.equal(store.getManagerOf('A', a.get('ic')!), a.get('ceo')!, 'IC 现汇报 CEO');
  });

  it('★reparent 守环：把 CEO 挂到 IC 下（IC 在 CEO 子树）→ 拒★', () => {
    const a = bootstrap('A', 'A');
    /* CEO 是根，无汇报边；但即便有，挂到自己子树成员下应拒。改测 mgr 挂到 ic 下（ic 在 mgr 子树）。 */
    assert.throws(() => svc.reparent({ orgId: 'A', workerId: a.get('mgr')!, newManagerWorkerId: a.get('ic')! }), InvalidOrgChartError, '成环应拒');
  });

  it('★reparent 守：自挂 → 拒★', () => {
    const a = bootstrap('A', 'A');
    assert.throws(() => svc.reparent({ orgId: 'A', workerId: a.get('ic')!, newManagerWorkerId: a.get('ic')! }), InvalidOrgChartError);
  });

  it('★reparent 守：新上级不存在 → 拒★', () => {
    const a = bootstrap('A', 'A');
    assert.throws(() => svc.reparent({ orgId: 'A', workerId: a.get('ic')!, newManagerWorkerId: 'ghost' }), InvalidOrgChartError);
  });

  /* ── offboard ── */

  it('★offboard：IC（无下属无在手任务）→ 标 offboarded★', () => {
    const a = bootstrap('A', 'A');
    svc.offboard({ orgId: 'A', workerId: a.get('ic')! });
    assert.equal(store.getWorker('A', a.get('ic')!)!.employmentStatus, 'offboarded');
  });

  it('★offboard 守：根 CEO → 拒（组织会无根）★', () => {
    const a = bootstrap('A', 'A');
    assert.throws(() => svc.offboard({ orgId: 'A', workerId: a.get('ceo')! }), InvalidOrgChartError, '根不可裁');
  });

  it('★offboard 守：有下属须先安置 → 缺 reparentReportsTo 拒；给了则下属改挂★', () => {
    const a = bootstrap('A', 'A');
    /* mgr 有下属 ic。缺 reparentReportsTo → 拒。 */
    assert.throws(() => svc.offboard({ orgId: 'A', workerId: a.get('mgr')! }), InvalidOrgChartError, '有下属须安置');
    /* 给 reparentReportsTo=CEO → ic 改挂 CEO，mgr 下线。 */
    svc.offboard({ orgId: 'A', workerId: a.get('mgr')!, reparentReportsTo: a.get('ceo')! });
    assert.equal(store.getWorker('A', a.get('mgr')!)!.employmentStatus, 'offboarded');
    assert.equal(store.getManagerOf('A', a.get('ic')!), a.get('ceo')!, 'ic 已改挂 CEO');
  });

  it('★offboard 守：有在手任务须先重分配★', () => {
    const a = bootstrap('A', 'A');
    /* 给 ic 派一个在手任务。 */
    store.insertTask({
      orgId: 'A', goalId: 'g1', parentTaskId: null, assignedToWorkerId: a.get('ic')!, accountableWorkerId: a.get('mgr')!,
      title: '活', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: [], resultSummary: null, dueAt: null, id: 'task-1', createdAt: clock, updatedAt: clock,
    });
    /* 缺 reassignTasksTo → 拒。 */
    assert.throws(() => svc.offboard({ orgId: 'A', workerId: a.get('ic')! }), InvalidOrgChartError, '有在手任务须重分配');
    /* 给 reassignTasksTo=mgr → 任务改派，ic 下线。 */
    svc.offboard({ orgId: 'A', workerId: a.get('ic')!, reassignTasksTo: a.get('mgr')! });
    assert.equal(store.getWorker('A', a.get('ic')!)!.employmentStatus, 'offboarded');
    assert.equal(store.getTask('A', 'task-1')!.assignedToWorkerId, a.get('mgr')!, '任务已改派给 mgr');
  });

  /* ── absorb ── */

  it('★absorb：B 并入 A，B 根接到 A 的 CEO 下，A 单根不变★', () => {
    const a = bootstrap('A', 'A');
    const b = bootstrap('B', 'B');
    const result = svc.absorb({ targetOrgId: 'A', sourceOrgId: 'B', mountUnderWorkerId: a.get('ceo')! });

    assert.equal(result.movedWorkers, 3, 'B 的 3 名 worker 迁入');
    /* B 的 worker 现在在 A 组织。 */
    const aWorkers = store.listWorkers('A');
    assert.equal(aWorkers.length, 6, 'A 现有 6 名 worker（原 3 + B 的 3）');
    assert.equal(store.listWorkers('B').length, 0, 'B 已空');
    /* B 根（B-CEO）现接到 A-CEO 下。 */
    assert.equal(store.getManagerOf('A', b.get('ceo')!), a.get('ceo')!, 'B 根接到 A 的 CEO');
    /* A 仍单根（只有 A-CEO 无上级）。 */
    const roots = store.listWorkers('A').filter((w) => store.getManagerOf('A', w.id) === null);
    assert.equal(roots.length, 1, 'A 单根不变');
    assert.equal(roots[0]!.id, a.get('ceo')!, '根仍是 A-CEO');
  });

  it('★absorb 守：roleCode 冲突（B 也有 ceo/mgr/ic）→ 自动加后缀★', () => {
    const a = bootstrap('A', 'A');
    bootstrap('B', 'B');
    const result = svc.absorb({ targetOrgId: 'A', sourceOrgId: 'B', mountUnderWorkerId: a.get('ceo')! });
    /* B 的 ceo/mgr/ic 都撞 A → 全部加后缀。 */
    assert.equal(result.renamedRoles.length, 3, '3 个冲突 roleCode 重命名');
    const roles = store.listPositions('A').map((p) => p.roleCode).sort();
    /* A 现有原 ceo/mgr/ic + B 的 ceo__from_B/mgr__from_B/ic__from_B。 */
    assert.ok(roles.includes('ceo') && roles.includes('ceo__from_B'), '原 ceo + B 的 ceo__from_B 共存');
    /* roleCode 仍唯一（无重复）。 */
    assert.equal(new Set(roles).size, roles.length, 'roleCode 全唯一');
  });

  it('★absorb 守：吸收自己 / 组织不存在 → 拒★', () => {
    const a = bootstrap('A', 'A');
    assert.throws(() => svc.absorb({ targetOrgId: 'A', sourceOrgId: 'A', mountUnderWorkerId: a.get('ceo')! }), InvalidOrgChartError, '不能吸收自己');
    assert.throws(() => svc.absorb({ targetOrgId: 'A', sourceOrgId: 'ghost', mountUnderWorkerId: a.get('ceo')! }), InvalidOrgChartError, '源组织不存在');
  });

  it('★absorb 守：挂载点不在目标组织 → 拒★', () => {
    bootstrap('A', 'A');
    bootstrap('B', 'B');
    assert.throws(() => svc.absorb({ targetOrgId: 'A', sourceOrgId: 'B', mountUnderWorkerId: 'ghost' }), InvalidOrgChartError);
  });

  it('★absorb 后派生数据也迁移：B 的任务现在 A 组织可见★', () => {
    const a = bootstrap('A', 'A');
    const b = bootstrap('B', 'B');
    store.insertTask({
      orgId: 'B', goalId: 'gb', parentTaskId: null, assignedToWorkerId: b.get('ic')!, accountableWorkerId: b.get('mgr')!,
      title: 'B任务', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: [], resultSummary: null, dueAt: null, id: 'btask', createdAt: clock, updatedAt: clock,
    });
    svc.absorb({ targetOrgId: 'A', sourceOrgId: 'B', mountUnderWorkerId: a.get('ceo')! });
    assert.ok(store.getTask('A', 'btask'), 'B 的任务迁到 A');
    assert.equal(store.getTask('B', 'btask'), undefined, 'B 组织已无该任务');
  });
});
