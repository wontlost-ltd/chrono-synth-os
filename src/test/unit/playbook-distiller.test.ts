import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { PlaybookDistiller } from '../../workforce/playbook-distiller.js';
import { PlaybookRegistry } from '../../workforce/playbook-registry.js';
import type { OrgTask, TaskStatus } from '../../workforce/types.js';

/* M3 组织经验蒸馏：执行历史 → 确定性度量 → 蒸馏门 → 改进候选。零-LLM,可复现。 */
describe('PlaybookDistiller（M3 组织经验蒸馏闭环·确定性半）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let distiller: PlaybookDistiller;
  let counter: number;

  /* 用真实激活 playbook 的 goalType（content_piece，激活版本 1）。 */
  const GOAL_TYPE = 'content_piece';

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    counter = 0;
    distiller = new PlaybookDistiller(store);
  });

  /** 造一个 goalType v1 的目标 + 一组任务（精确控制 taskType/status/due/updatedAt）。 */
  function seedGoal(tasks: Array<{ taskType: string; status: TaskStatus; dueAt?: number | null; updatedAt?: number }>): string {
    const goalId = `goal-${++counter}`;
    store.insertGoal({
      id: goalId, orgId: 'org-1', ownerWorkerId: 'mgr', title: goalId, description: '',
      goalType: GOAL_TYPE, status: 'completed', playbookVersion: 1, sourceMarketplaceTaskId: null, createdAt: 1000, updatedAt: 1000,
    });
    for (const spec of tasks) {
      const t: Omit<OrgTask, 'tenantId' | 'resumeAttemptCount' | 'lastWakeEventId'> = {
        id: `task-${++counter}`, orgId: 'org-1', goalId, parentTaskId: null, assignedToWorkerId: 'ic',
        accountableWorkerId: 'mgr', title: spec.taskType, taskType: spec.taskType, status: spec.status,
        riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [],
        resultSummary: null, dueAt: spec.dueAt ?? null, createdAt: 1000, updatedAt: spec.updatedAt ?? 1000,
      };
      store.insertTask(t);
    }
    return goalId;
  }

  it('样本不足(<5) → insufficient_samples，不产候选', () => {
    for (let i = 0; i < 3; i++) seedGoal([{ taskType: 'writing', status: 'approved' }]);
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'insufficient_samples');
    if (r.kind === 'insufficient_samples') assert.equal(r.required, 5);
  });

  it('样本充足但全干净(无返工/逾期/升级) → no_weakness', () => {
    for (let i = 0; i < 6; i++) seedGoal([{ taskType: 'writing', status: 'approved' }, { taskType: 'review', status: 'approved' }]);
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'no_weakness');
    if (r.kind === 'no_weakness') assert.equal(r.sampleGoals, 6);
  });

  it('★返工高★：某环节返工率超阈值 → candidate + tighten_acceptance_criteria', () => {
    /* 6 个目标，writing 环节一半 rejected（返工率 50% > 25%）。 */
    for (let i = 0; i < 6; i++) {
      seedGoal([{ taskType: 'writing', status: i % 2 === 0 ? 'rejected' : 'approved' }]);
    }
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'candidate');
    if (r.kind !== 'candidate') return;
    assert.equal(r.candidate.basedOnVersion, 1);
    assert.equal(r.candidate.proposedVersion, 2);
    const w = r.candidate.weaknesses.find((x) => x.taskType === 'writing')!;
    assert.equal(w.direction, 'tighten_acceptance_criteria');
    assert.match(w.rationale, /返工/);
  });

  it('★逾期高★：某环节逾期率超阈值 → relax_sla', () => {
    /* writing 全部逾期：仍在手(submitted) + updatedAt > dueAt。 */
    for (let i = 0; i < 6; i++) {
      seedGoal([{ taskType: 'writing', status: 'submitted', dueAt: 1000, updatedAt: 5000 }]);
    }
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'candidate');
    if (r.kind !== 'candidate') return;
    const w = r.candidate.weaknesses.find((x) => x.taskType === 'writing')!;
    assert.equal(w.direction, 'relax_sla');
    assert.match(w.rationale, /逾期/);
  });

  it('★返工+逾期双高★：split_stage', () => {
    /* writing 既返工(rejected)又（不算逾期因 rejected 离手）——构造双高需在手且逾期。
     * 用两条 writing 任务/目标：一条 rejected、一条 submitted+逾期 → 返工率 50% + 逾期率 50%。 */
    for (let i = 0; i < 6; i++) {
      seedGoal([
        { taskType: 'writing', status: 'rejected' },
        { taskType: 'writing', status: 'submitted', dueAt: 1000, updatedAt: 5000 },
      ]);
    }
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'candidate');
    if (r.kind !== 'candidate') return;
    const w = r.candidate.weaknesses.find((x) => x.taskType === 'writing')!;
    assert.equal(w.direction, 'split_stage');
  });

  it('★确定性可复现★：相同执行历史 → 相同候选', () => {
    for (let i = 0; i < 6; i++) seedGoal([{ taskType: 'writing', status: i % 2 === 0 ? 'rejected' : 'approved' }]);
    assert.deepEqual(distiller.distill('org-1', GOAL_TYPE), distiller.distill('org-1', GOAL_TYPE));
  });

  it('只看当前激活版本样本：旧版本(v0... 实为别版)目标不混入', () => {
    /* 造 6 个 v1 干净目标 + 几个 v2 的（playbookVersion=2）有返工——只算 v1 的 → no_weakness。 */
    for (let i = 0; i < 6; i++) seedGoal([{ taskType: 'writing', status: 'approved' }]);
    /* 直接插一个 v2 目标（不同版本，不该影响 v1 蒸馏，因激活版本是 1）。 */
    store.insertGoal({ id: 'v2-goal', orgId: 'org-1', ownerWorkerId: 'mgr', title: 'v2', description: '', goalType: GOAL_TYPE, status: 'completed', playbookVersion: 2, sourceMarketplaceTaskId: null, createdAt: 1000, updatedAt: 1000 });
    store.insertTask({ id: 'v2-task', orgId: 'org-1', goalId: 'v2-goal', parentTaskId: null, assignedToWorkerId: 'ic', accountableWorkerId: 'mgr', title: 'w', taskType: 'writing', status: 'rejected', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000 });
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'no_weakness', 'v2 的返工不混入 v1 蒸馏');
  });

  it('★闭环★：候选 → 离线编译新版(stand-in) → register 更高 version → getActive 切新规则', () => {
    /* 蒸馏出候选。 */
    for (let i = 0; i < 6; i++) seedGoal([{ taskType: 'writing', status: i % 2 === 0 ? 'rejected' : 'approved' }]);
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'candidate');
    if (r.kind !== 'candidate') return;
    /* 离线 LLM 据候选编译新 playbook（这里手工 stand-in），provenance=distilled、version=proposedVersion。 */
    const reg = new PlaybookRegistry();
    reg.register({
      goalType: GOAL_TYPE, version: 1, provenance: 'reference',
      qualityRubric: [{ dimension: 'd', description: 'x' }],
      decompose: () => [{ assigneeRoleCode: 'writer_ic', title: 'old', taskType: 'writing', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '旧', requiredCapabilities: [] }],
    });
    reg.register({
      goalType: GOAL_TYPE, version: r.candidate.proposedVersion, provenance: 'distilled',
      qualityRubric: [{ dimension: 'd', description: 'x' }],
      decompose: () => [{ assigneeRoleCode: 'writer_ic', title: 'new', taskType: 'writing', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '更明确的验收标准', requiredCapabilities: [] }],
    });
    /* 闭环成立：激活切到蒸馏版本，规则确实变（验收标准更明确）。 */
    assert.equal(reg.activeVersionOf(GOAL_TYPE), 2);
    assert.equal(reg.getActive(GOAL_TYPE)!.provenance, 'distilled');
    assert.match(reg.getActive(GOAL_TYPE)!.decompose({ title: 't', description: '' })[0]!.acceptanceCriteria, /更明确/);
  });

  it('★升级率高★：goal 升级率超阈值 → add_escalation_path（两环节样本数并列 → 字典序兜底锚定）', () => {
    /* 6 个目标，每个两条任务 aaa/zzz（样本数并列各 6）且各有升级 → 升级率 100% > 30%。
     * 锚点并列 → 显式 tie-breaker 字典序选 'aaa'（不依赖 sort 稳定性）。 */
    for (let i = 0; i < 6; i++) {
      const goalId = seedGoal([{ taskType: 'zzz', status: 'approved' }, { taskType: 'aaa', status: 'approved' }]);
      for (const t of store.listTasksByGoal('org-1', goalId)) {
        store.insertEscalation({
          id: `es-${++counter}`, orgId: 'org-1', taskId: t.id, fromWorkerId: 'ic', toWorkerId: 'mgr',
          parentEscalationId: null, depth: 0, status: 'pending', reason: 'x', resolution: null,
          correlationId: null, createdAt: 1000, decidedAt: null,
        });
      }
    }
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'candidate');
    if (r.kind !== 'candidate') return;
    const w = r.candidate.weaknesses.find((x) => x.direction === 'add_escalation_path')!;
    assert.ok(w, '产出 add_escalation_path');
    assert.equal(w.taskType, 'aaa', '并列时字典序兜底锚定 aaa');
    assert.match(w.rationale, /升级率/);
  });

  it('★阈值边界★：返工率恰好 25%(=阈值) → 仍触发(>=)', () => {
    /* 每目标 4 条 writing：1 rejected → 返工率 25%。 */
    for (let i = 0; i < 6; i++) {
      seedGoal([
        { taskType: 'writing', status: 'rejected' },
        { taskType: 'writing', status: 'approved' },
        { taskType: 'writing', status: 'approved' },
        { taskType: 'writing', status: 'approved' },
      ]);
    }
    const r = distiller.distill('org-1', GOAL_TYPE);
    assert.equal(r.kind, 'candidate', '25% 恰达阈值即弱点(>=)');
  });

  it('★端到端闭环(defaultPlaybookRegistry)★：注册 v1→蒸馏→注册 v2→distill 基于 v2 且只看 v2 样本', async () => {
    /* 用独立 goalType 接入**进程级** defaultPlaybookRegistry，证明生产路径的「当前激活版本」语义。 */
    const { defaultPlaybookRegistry } = await import('../../workforce/decomposition-playbook.js');
    const GT = 'm3_e2e_demo';
    const mkPb = (version: number, provenance: 'reference' | 'distilled', crit: string) => ({
      goalType: GT, version, provenance,
      qualityRubric: [{ dimension: 'd', description: 'x' }],
      decompose: () => [{ assigneeRoleCode: 'r', title: 't', taskType: 'step', riskLevel: 'low' as const, allowsToolExecution: false, acceptanceCriteria: crit, requiredCapabilities: [] }],
    });
    defaultPlaybookRegistry.register(mkPb(1, 'reference', '旧标准'));
    /* v1 样本：返工高 → 蒸馏出候选。 */
    for (let i = 0; i < 6; i++) {
      const gid = `e2e-v1-${++counter}`;
      store.insertGoal({ id: gid, orgId: 'org-1', ownerWorkerId: 'mgr', title: gid, description: '', goalType: GT, status: 'completed', playbookVersion: 1, sourceMarketplaceTaskId: null, createdAt: 1000, updatedAt: 1000 });
      store.insertTask({ id: `e2e-t-${++counter}`, orgId: 'org-1', goalId: gid, parentTaskId: null, assignedToWorkerId: 'ic', accountableWorkerId: 'mgr', title: 'step', taskType: 'step', status: i % 2 === 0 ? 'rejected' : 'approved', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000 });
    }
    const r1 = distiller.distill('org-1', GT);
    assert.equal(r1.kind, 'candidate');
    if (r1.kind !== 'candidate') return;
    assert.equal(r1.candidate.basedOnVersion, 1);
    /* 离线编译新版(stand-in)：register distilled v2 → 激活切到 v2。 */
    defaultPlaybookRegistry.register(mkPb(r1.candidate.proposedVersion, 'distilled', '更明确标准'));
    assert.equal(defaultPlaybookRegistry.activeVersionOf(GT), 2);
    /* 再 distill：基于 v2，且 v1 样本不混入(只 v2,无样本) → insufficient_samples。 */
    const r2 = distiller.distill('org-1', GT);
    assert.equal(r2.kind, 'insufficient_samples', '基于 v2 激活版本,v1 样本已隔离');
  });

  it('未知 goalType → insufficient_samples(0)', () => {
    const r = distiller.distill('org-1', 'nope');
    assert.equal(r.kind, 'insufficient_samples');
  });
});
