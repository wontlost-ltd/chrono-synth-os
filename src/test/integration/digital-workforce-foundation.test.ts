/**
 * 数字员工组织奠基集成测试（digital workforce M1）。
 *
 * 端到端验证核心因果链：bootstrap 一个 3 层数字组织 → 数字主管运行一个内容目标 → 确定性分解 →
 * 委派给直接下属 IC → IC 执行 → 逐级汇报 → 主管聚合。全零-LLM、确定性可复现。
 * 并做对照实验：数字组织 vs 单 agent 一把梭——证明组织化的可归因/可审计优势（蓝图 MVP 铁律）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { OrgPlanningService, UnsupportedGoalTypeError } from '../../workforce/org-planning-service.js';
import { GOAL_TYPE_CONTENT_PIECE } from '../../workforce/decomposition-playbook.js';
import { runGoalAsSingleAgent } from '../../workforce/single-agent-baseline.js';

/** 内容运营小队：数字主管 + 研究/写作/审核/发布 4 个 IC（全是主管的直接下属）。 */
function contentPodSpecs(): WorkerSpec[] {
  return [
    { roleCode: 'managing_editor', title: '数字主管', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-me', managerRoleCode: null },
    { roleCode: 'researcher_ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: '研究员', personaId: 'p-r', managerRoleCode: 'managing_editor' },
    { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写手', personaId: 'p-w', managerRoleCode: 'managing_editor' },
    { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'managing_editor' },
    { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'managing_editor' },
  ];
}

describe('数字员工组织奠基（M1：分解-委派-执行-汇报-聚合，零-LLM）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let chart: OrgChartService;
  let planning: OrgPlanningService;
  let counter: number;
  const FIXED_NOW = 1000;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    counter = 0;
    const idgen = (): string => `id-${++counter}`;
    chart = new OrgChartService(store, () => FIXED_NOW, idgen);
    planning = new OrgPlanningService(store, chart, () => FIXED_NOW, idgen);
  });

  it('完整因果链：主管运行内容目标 → 分解4任务 → 委派 → 执行 → 汇报 → 聚合', () => {
    const boot = chart.bootstrap('org-1', contentPodSpecs());
    const mgrId = boot.workerIdByRole.get('managing_editor')!;

    const result = planning.runGoal(
      'org-1', mgrId,
      { title: '咖啡冲煮指南', description: '面向新手', goalType: GOAL_TYPE_CONTENT_PIECE },
      boot.workerIdByRole,
    );

    assert.equal(result.taskCount, 4, '分解为研究/写作/审核/发布 4 个任务');
    /* 4 个任务 final report + 1 个 manager 聚合 report = 5。 */
    assert.equal(result.reportCount, 5, '4 下属汇报 + 1 主管聚合');
    assert.match(result.executiveSummary, /咖啡冲煮指南/, '聚合摘要带目标');
    assert.match(result.executiveSummary, /4 个环节/, '聚合体现 4 环节');

    /* 任务确实落库 + 委派给正确 IC + 已执行（submitted + 有产出）。 */
    const tasks = store.listTasksByGoal('org-1', result.goalId);
    assert.equal(tasks.length, 4);
    assert.ok(tasks.every((t) => t.status === 'submitted'), '全部已提交产出');
    assert.ok(tasks.every((t) => t.resultSummary !== null), '全部有产出摘要');
    /* 研究任务委派给研究员 IC。 */
    const researchTask = tasks.find((t) => t.taskType === 'research')!;
    assert.equal(researchTask.assignedToWorkerId, boot.workerIdByRole.get('researcher_ic'));
    assert.equal(researchTask.accountableWorkerId, mgrId, '主管问责');
  });

  it('确定性可复现：相同组织+目标+时钟 → 相同 task 结构 + 相同聚合摘要', () => {
    const run = (): { tasks: string[]; summary: string } => {
      const fdb = createMemoryDatabase();
      runDslSqliteMigrations(fdb);
      const s = new OrgWorkforceStore(fdb, 'tenant-a');
      let c = 0;
      const idg = (): string => `id-${++c}`;
      const ch = new OrgChartService(s, () => FIXED_NOW, idg);
      const pl = new OrgPlanningService(s, ch, () => FIXED_NOW, idg);
      const b = ch.bootstrap('org-1', contentPodSpecs());
      const r = pl.runGoal('org-1', b.workerIdByRole.get('managing_editor')!, { title: 'X', description: 'D', goalType: GOAL_TYPE_CONTENT_PIECE }, b.workerIdByRole);
      const tasks = s.listTasksByGoal('org-1', r.goalId).map((t) => `${t.taskType}:${t.title}:${t.resultSummary}`);
      return { tasks, summary: r.executiveSummary };
    };
    const a = run();
    const b = run();
    assert.deepEqual(a.tasks, b.tasks, '任务结构逐字可复现');
    assert.equal(a.summary, b.summary, '聚合摘要逐字可复现');
  });

  it('对照实验（公平）：数字组织 vs 单 agent——核心是「可归因责任环节」而非日志条数', () => {
    const boot = chart.bootstrap('org-1', contentPodSpecs());
    const pod = planning.runGoal(
      'org-1', boot.workerIdByRole.get('managing_editor')!,
      { title: '主题Y', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
      boot.workerIdByRole,
    );
    const single = runGoalAsSingleAgent({ title: '主题Y', description: '' });

    /* 公平性：单 agent 故意记了**更多**事件（loggedEvents=99 > 组织的步数）——证明组织优势不靠日志条数。 */
    assert.ok(single.loggedEvents > pod.attributableSteps, '单 agent 即便记更多事件……');
    /* ……但单 agent 没有任何「具名问责的责任环节」（黑盒整体）。 */
    assert.equal(single.accountableStages, 0, '单 agent 无环节级具名问责');
    /* 数字组织：每个交付环节都有具名 accountable worker + 具名 final 汇报 → 可归因责任环节 = 4。 */
    assert.equal(pod.accountableStages, 4, '组织有 4 个可归因责任环节');
    assert.ok(pod.accountableStages > single.accountableStages, `组织可归因责任环节(${pod.accountableStages}) > 单agent(${single.accountableStages})`);
    /* 每个责任环节都能定位到「谁负责 + 谁汇报」（白盒证据）。 */
    const tasks = store.listTasksByGoal('org-1', pod.goalId);
    assert.ok(tasks.every((t) => t.accountableWorkerId && t.assignedToWorkerId), '每环节有具名问责人+执行人');
    const trail = planning.reportTrail('org-1', pod.goalId);
    assert.ok(trail.every((r) => r.fromWorkerId && r.toWorkerId), '每条汇报有具名来源/去向');
  });

  it('零-LLM：整条因果链不需任何 LLM provider（无 provider 注入也跑通）', () => {
    /* 本测试全程未构造/注入任何 LLM——能跑通即证明组织决策/分解/聚合纯确定性。 */
    const boot = chart.bootstrap('org-1', contentPodSpecs());
    const result = planning.runGoal(
      'org-1', boot.workerIdByRole.get('managing_editor')!,
      { title: 'Z', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
      boot.workerIdByRole,
    );
    assert.ok(result.goalId);
    assert.equal(result.taskCount, 4);
  });

  it('未知 goalType → 拒绝（不臆造战略，不偷调推理）', () => {
    const boot = chart.bootstrap('org-1', contentPodSpecs());
    assert.throws(
      () => planning.runGoal('org-1', boot.workerIdByRole.get('managing_editor')!, { title: '制定公司战略', description: '', goalType: 'strategy_planning' }, boot.workerIdByRole),
      UnsupportedGoalTypeError,
    );
  });

  it('原子性（Codex 复审）：分解里缺下属 → 整条失败，不留半成品 goal/task', () => {
    /* 缺一个岗位（writer_ic）的组织：分解需要它但找不到 → 应在落库前抛错，不留 active goal。 */
    const incomplete: WorkerSpec[] = contentPodSpecs().filter((s) => s.roleCode !== 'writer_ic');
    const boot = chart.bootstrap('org-2', incomplete);
    assert.throws(
      () => planning.runGoal('org-2', boot.workerIdByRole.get('managing_editor')!, { title: 'T', description: '', goalType: GOAL_TYPE_CONTENT_PIECE }, boot.workerIdByRole),
      /writer_ic|没有该直接下属/,
    );
    /* 关键：失败后 org-2 没有任何 goal/task 落库（预校验在落库前，因果链 DAG 永远完整或不存在）。 */
    const goalRows = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM org_goals WHERE tenant_id = ? AND org_id = ?`).get('tenant-a', 'org-2');
    assert.equal(Number(goalRows?.n ?? 0), 0, '失败不留半成品 goal');
    const taskRows = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM org_tasks WHERE tenant_id = ? AND org_id = ?`).get('tenant-a', 'org-2');
    assert.equal(Number(taskRows?.n ?? 0), 0, '失败不留半成品 task');
  });

  it('A0 契约持久化：任务带 risk/tool-eligible/acceptance/capabilities 落库并 round-trip', () => {
    const boot = chart.bootstrap('org-1', contentPodSpecs());
    const result = planning.runGoal(
      'org-1', boot.workerIdByRole.get('managing_editor')!,
      { title: '主题C', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
      boot.workerIdByRole,
    );
    const tasks = store.listTasksByGoal('org-1', result.goalId);
    /* 契约字段确实落库 + 读回正确（含 JSON capabilities + bool）。 */
    const publish = tasks.find((t) => t.taskType === 'publish_prep')!;
    assert.equal(publish.riskLevel, 'high', '发布环节高风险落库');
    assert.equal(publish.allowsToolExecution, true, 'bool round-trip（int 1→true）');
    assert.ok(publish.acceptanceCriteria.includes('确认'), '验收标准落库');
    const research = tasks.find((t) => t.taskType === 'research')!;
    assert.deepEqual(research.requiredCapabilities, ['research'], 'capabilities JSON round-trip');
    assert.equal(research.allowsToolExecution, false, 'bool round-trip（int 0→false）');
    /* 每个任务都有完整契约（供 B/D/E 引用）。 */
    assert.ok(tasks.every((t) => ['low', 'medium', 'high'].includes(t.riskLevel)));
    assert.ok(tasks.every((t) => t.requiredCapabilities.length > 0));
  });

  it('汇报链可观测：reportTrail 返回完整证据链', () => {
    const boot = chart.bootstrap('org-1', contentPodSpecs());
    const result = planning.runGoal(
      'org-1', boot.workerIdByRole.get('managing_editor')!,
      { title: '主题W', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
      boot.workerIdByRole,
    );
    const trail = planning.reportTrail('org-1', result.goalId);
    assert.equal(trail.length, 5, '4 下属 final + 1 主管聚合');
    assert.ok(trail.every((r) => r.reportType === 'final'));
  });
});
