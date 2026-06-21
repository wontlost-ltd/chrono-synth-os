import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { OrgPlanningService } from '../../workforce/org-planning-service.js';
import { OrgAutorunService, type QueuedGoal, type OrgAutonomyPolicy } from '../../workforce/org-autorun-service.js';
import {
  GOAL_TYPE_CONTENT_PIECE, GOAL_TYPE_DATA_ANALYSIS,
} from '../../workforce/decomposition-playbook.js';

/* M5 有限自主运营：预算门 + 风险天花板，自主规划派活但高风险留人类。确定性零-LLM。 */
describe('OrgAutorunService（M5 有限自主运营）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let planning: OrgPlanningService;
  let workerIdByRole: ReadonlyMap<string, string>;
  let mgrId: string;

  /* 同时含内容运营(发布 high)+数据分析(取数 medium) 岗位的 pod，覆盖两种风险档。 */
  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'managing_editor', title: '主编', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-me', managerRoleCode: null },
      { roleCode: 'researcher_ic', title: '研究', jobFamily: 'ic', seniority: 'ic', displayName: '研究', personaId: 'p-r', managerRoleCode: 'managing_editor' },
      { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写作', personaId: 'p-w', managerRoleCode: 'managing_editor' },
      { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'managing_editor' },
      { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'managing_editor' },
      { roleCode: 'analyst_lead_ic', title: '分析负责', jobFamily: 'ic', seniority: 'ic', displayName: '分析负责', personaId: 'p-al', managerRoleCode: 'managing_editor' },
      { roleCode: 'data_eng_ic', title: '数据', jobFamily: 'ic', seniority: 'ic', displayName: '数据', personaId: 'p-de', managerRoleCode: 'managing_editor' },
      { roleCode: 'analyst_ic', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: '分析', personaId: 'p-a', managerRoleCode: 'managing_editor' },
      { roleCode: 'reporter_ic', title: '报告', jobFamily: 'ic', seniority: 'ic', displayName: '报告', personaId: 'p-rp', managerRoleCode: 'managing_editor' },
    ];
  }

  function dataGoal(n: number): QueuedGoal {
    return { managerWorkerId: mgrId, title: `分析需求${n}`, description: '', goalType: GOAL_TYPE_DATA_ANALYSIS };
  }
  function contentGoal(n: number): QueuedGoal {
    return { managerWorkerId: mgrId, title: `内容${n}`, description: '', goalType: GOAL_TYPE_CONTENT_PIECE };
  }

  const policy = (maxGoalsPerCycle: number, maxAutoRiskLevel: OrgAutonomyPolicy['maxAutoRiskLevel'] = 'medium'): OrgAutonomyPolicy =>
    ({ maxGoalsPerCycle, maxAutoRiskLevel });

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    let c = 0;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++c}`);
    const boot = chart.bootstrap('org-1', pod());
    workerIdByRole = boot.workerIdByRole;
    mgrId = boot.workerIdByRole.get('managing_editor')!;
    planning = new OrgPlanningService(store, chart, () => 1000, () => `gen-${++c}`);
  });

  function svc(): OrgAutorunService {
    return new OrgAutorunService(planning, workerIdByRole);
  }

  it('★预算门★：队列 5 个 data 目标，预算 2 → 跑 2，其余 3 deferred_budget', () => {
    const queue = [dataGoal(1), dataGoal(2), dataGoal(3), dataGoal(4), dataGoal(5)];
    const r = svc().runCycle('org-1', queue, policy(2));
    assert.equal(r.ranCount, 2);
    assert.equal(r.deferredBudget, 3);
    assert.equal(r.outcomes.filter((o) => o.kind === 'ran').length, 2);
    /* 真落库：跑了 2 个目标。 */
    assert.equal(store.listGoals('org-1').length, 2);
  });

  it('★风险天花板★：content 目标(含发布 high) + 天花板 medium → deferred_high_risk，绝不自主运行', () => {
    const r = svc().runCycle('org-1', [contentGoal(1)], policy(5, 'medium'));
    assert.equal(r.ranCount, 0);
    assert.equal(r.deferredHighRisk, 1);
    const o = r.outcomes[0]!;
    assert.equal(o.kind, 'deferred_high_risk');
    if (o.kind === 'deferred_high_risk') assert.equal(o.maxTaskRisk, 'high');
    /* 未落库（没自主拉起）。 */
    assert.equal(store.listGoals('org-1').length, 0);
  });

  it('★风险天花板放开★：天花板 high → content 目标可自主运行', () => {
    const r = svc().runCycle('org-1', [contentGoal(1)], policy(5, 'high'));
    assert.equal(r.ranCount, 1);
    assert.equal(r.deferredHighRisk, 0);
  });

  it('混合队列：data(medium 可跑) + content(high 留人类)，天花板 medium', () => {
    const r = svc().runCycle('org-1', [dataGoal(1), contentGoal(1), dataGoal(2)], policy(5, 'medium'));
    assert.equal(r.ranCount, 2, '2 个 data 自主跑');
    assert.equal(r.deferredHighRisk, 1, '1 个 content 留人类');
    assert.equal(store.listGoals('org-1').length, 2);
  });

  it('★失败隔离★：未知 goalType → failed，不中断后续目标', () => {
    const bad: QueuedGoal = { managerWorkerId: mgrId, title: 'x', description: '', goalType: 'nope' };
    const r = svc().runCycle('org-1', [bad, dataGoal(1)], policy(5));
    assert.equal(r.failed, 1);
    assert.equal(r.ranCount, 1, '坏目标不中断后续 data 目标');
  });

  it('★失败隔离★：缺下属岗位 → failed，不中断', () => {
    /* 用只有 manager 的 org（无 data 岗位）。 */
    const db2 = createMemoryDatabase();
    runDslSqliteMigrations(db2);
    const store2 = new OrgWorkforceStore(db2, 'tenant-a');
    let c = 0;
    const chart2 = new OrgChartService(store2, () => 1000, () => `x-${++c}`);
    const boot2 = chart2.bootstrap('org-1', [{ roleCode: 'managing_editor', title: 'm', jobFamily: 'manager', seniority: 'lead', displayName: 'm', personaId: 'p', managerRoleCode: null }]);
    const planning2 = new OrgPlanningService(store2, chart2, () => 1000, () => `g-${++c}`);
    const svc2 = new OrgAutorunService(planning2, boot2.workerIdByRole);
    const r = svc2.runCycle('org-1', [dataGoal(1)], policy(5));
    assert.equal(r.failed, 1, '缺 data 岗位下属 → failed');
    assert.equal(r.ranCount, 0);
  });

  it('★确定性可复现★：相同队列+组织 → 相同运行计数', () => {
    const queue = [dataGoal(1), dataGoal(2), contentGoal(1)];
    const r1 = svc().runCycle('org-1', queue, policy(5, 'medium'));
    /* 全新组织重跑（同结构）。 */
    const db2 = createMemoryDatabase();
    runDslSqliteMigrations(db2);
    const store2 = new OrgWorkforceStore(db2, 'tenant-a');
    let c = 0;
    const chart2 = new OrgChartService(store2, () => 1000, () => `id-${++c}`);
    const boot2 = chart2.bootstrap('org-1', pod());
    const planning2 = new OrgPlanningService(store2, chart2, () => 1000, () => `gen-${++c}`);
    const svc2 = new OrgAutorunService(planning2, boot2.workerIdByRole);
    const r2 = svc2.runCycle('org-1', queue.map((g) => ({ ...g, managerWorkerId: boot2.workerIdByRole.get('managing_editor')! })), policy(5, 'medium'));
    assert.equal(r1.ranCount, r2.ranCount);
    assert.equal(r1.deferredHighRisk, r2.deferredHighRisk);
  });

  it('预算 0 → 全部 deferred_budget，不运行任何目标', () => {
    const r = svc().runCycle('org-1', [dataGoal(1), dataGoal(2)], policy(0));
    assert.equal(r.ranCount, 0);
    assert.equal(r.deferredBudget, 2);
  });

  it('空队列 → 空结果', () => {
    const r = svc().runCycle('org-1', [], policy(5));
    assert.equal(r.ranCount, 0);
    assert.equal(r.outcomes.length, 0);
  });

  it('★fail-closed★：策略漏传 maxAutoRiskLevel → 按 medium 保守，content(high) 仍 deferred_high_risk', () => {
    /* 模拟 JS 调用方/反序列化漏传天花板字段。 */
    const badPolicy = { maxGoalsPerCycle: 5 } as unknown as OrgAutonomyPolicy;
    const r = svc().runCycle('org-1', [contentGoal(1)], badPolicy);
    assert.equal(r.ranCount, 0, '漏传天花板 → 不放行高风险');
    assert.equal(r.deferredHighRisk, 1);
    assert.equal(store.listGoals('org-1').length, 0, '未自主落库');
  });

  it('★fail-closed★：非法风险天花板值 → 按 medium 保守挡 high', () => {
    const badPolicy = { maxGoalsPerCycle: 5, maxAutoRiskLevel: 'critical' } as unknown as OrgAutonomyPolicy;
    const r = svc().runCycle('org-1', [contentGoal(1)], badPolicy);
    assert.equal(r.deferredHighRisk, 1, '非法天花板按 medium → 挡 high');
  });

  it('★fail-closed★：非法预算(NaN) → 按 0，全部 deferred_budget', () => {
    const badPolicy = { maxGoalsPerCycle: NaN, maxAutoRiskLevel: 'medium' } as unknown as OrgAutonomyPolicy;
    const r = svc().runCycle('org-1', [dataGoal(1), dataGoal(2)], badPolicy);
    assert.equal(r.ranCount, 0, 'NaN 预算 → 不运行');
    assert.equal(r.deferredBudget, 2);
  });

  it('★天花板边界★：maxAutoRiskLevel=low(最严)→ data(含 medium 取数)被挡，不被 ?? 误升级', () => {
    /* RISK_ORDER[low]=0 是 falsy 但 ?? 只对 null/undefined 触发 → low 天花板生效不被误升 medium。
     * data_analysis 含 medium 任务(取数/复核) → low 天花板下应 deferred_high_risk(>low)。 */
    const r = svc().runCycle('org-1', [dataGoal(1)], policy(5, 'low'));
    assert.equal(r.ranCount, 0, 'low 天花板挡住 medium 任务的目标');
    assert.equal(r.deferredHighRisk, 1);
    const o = r.outcomes[0]!;
    if (o.kind === 'deferred_high_risk') assert.equal(o.maxTaskRisk, 'medium');
  });
});
