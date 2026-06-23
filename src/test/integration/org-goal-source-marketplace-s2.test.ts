/**
 * 工单溯源 S2——org_goals.source_marketplace_task_id：目标可追溯到接来的市场工单。
 *
 * 验证：insertGoal 带/不带 sourceMarketplaceTaskId 都正确落库+回读；runGoal 透传源工单 id 到目标；
 * 内部直接下发的目标 source 恒为 null（不污染）。这是「市场工单→组织目标」桥接的审计地基。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { OrgPlanningService } from '../../workforce/org-planning-service.js';
import { GOAL_TYPE_DATA_ANALYSIS } from '../../workforce/decomposition-playbook.js';

describe('OrgGoal 工单溯源 S2（source_marketplace_task_id）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let clock: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    clock = 1000;
  });

  it('★insertGoal 带 source → 回读保留★', () => {
    store.insertGoal({
      id: 'g1', orgId: 'acme', ownerWorkerId: 'w1', title: '市场来的活', description: '',
      goalType: 'x', status: 'active', playbookVersion: 1, sourceMarketplaceTaskId: 'mkt-task-42',
      createdAt: clock, updatedAt: clock,
    });
    assert.equal(store.getGoal('acme', 'g1')!.sourceMarketplaceTaskId, 'mkt-task-42');
  });

  it('★insertGoal 不带 source（内部下发）→ null★', () => {
    store.insertGoal({
      id: 'g2', orgId: 'acme', ownerWorkerId: 'w1', title: '内部目标', description: '',
      goalType: 'x', status: 'active', playbookVersion: 1, sourceMarketplaceTaskId: null,
      createdAt: clock, updatedAt: clock,
    });
    assert.equal(store.getGoal('acme', 'g2')!.sourceMarketplaceTaskId, null);
  });

  it('★listGoals 也带回 source★', () => {
    store.insertGoal({ id: 'g3', orgId: 'acme', ownerWorkerId: 'w1', title: 'a', description: '', goalType: 'x', status: 'active', playbookVersion: 1, sourceMarketplaceTaskId: 'mkt-7', createdAt: clock, updatedAt: clock });
    const g = store.listGoals('acme').find((x) => x.id === 'g3')!;
    assert.equal(g.sourceMarketplaceTaskId, 'mkt-7');
  });

  it('★runGoal 透传 source 到落库目标★', () => {
    /* 建一个能跑 data_analysis 的最小组织：lead + 5 个对应岗位 IC。 */
    const pod: WorkerSpec[] = [
      { roleCode: 'lead', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: 'L', personaId: 'p-lead', managerRoleCode: null },
      { roleCode: 'analyst_lead_ic', title: '需求', jobFamily: 'ic', seniority: 'ic', displayName: 'A', personaId: 'p-al', managerRoleCode: 'lead' },
      { roleCode: 'data_eng_ic', title: '取数', jobFamily: 'ic', seniority: 'ic', displayName: 'D', personaId: 'p-de', managerRoleCode: 'lead' },
      { roleCode: 'analyst_ic', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: 'N', personaId: 'p-an', managerRoleCode: 'lead' },
      { roleCode: 'reviewer_ic', title: '复核', jobFamily: 'ic', seniority: 'ic', displayName: 'R', personaId: 'p-rv', managerRoleCode: 'lead' },
      { roleCode: 'reporter_ic', title: '报告', jobFamily: 'ic', seniority: 'ic', displayName: 'P', personaId: 'p-rp', managerRoleCode: 'lead' },
    ];
    let c = 0;
    const chart = new OrgChartService(store, () => clock, () => `id-${++c}`);
    const boot = chart.bootstrap('acme', pod);
    const leadId = boot.workerIdByRole.get('lead')!;
    const planning = new OrgPlanningService(store, chart, () => clock, () => `gen-${++c}`);
    const workerIdByRole = new Map([...boot.workerIdByRole]);

    const result = planning.runGoal(
      'acme', leadId,
      { title: '市场分析工单', description: '', goalType: GOAL_TYPE_DATA_ANALYSIS, sourceMarketplaceTaskId: 'mkt-task-99' },
      workerIdByRole,
    );
    const goal = store.getGoal('acme', result.goalId)!;
    assert.equal(goal.sourceMarketplaceTaskId, 'mkt-task-99', 'runGoal 透传源工单 id 到落库目标');

    /* 不带 source 的内部下发 → null。 */
    const internal = planning.runGoal(
      'acme', leadId,
      { title: '内部分析', description: '', goalType: GOAL_TYPE_DATA_ANALYSIS },
      workerIdByRole,
    );
    assert.equal(store.getGoal('acme', internal.goalId)!.sourceMarketplaceTaskId, null, '内部下发 source=null');
  });
});
