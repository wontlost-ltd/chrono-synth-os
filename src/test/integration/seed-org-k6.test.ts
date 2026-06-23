/**
 * K6（ADR-0056）数字员工组织 seed——一键部署的 seed 步骤的确定性逻辑验证。
 *
 * 锁住 seed-org CLI 用的同一组服务（ChronoSynthOS + OrgChartService + WorkforcePersonaBootstrapService）：
 * 落一个 15 名 / 4 原型的完整组织，各有独立认知内核；**可安全重跑**（幂等 no-op）；原型多样性 4/4；
 * 确定性可复现。容器编排（compose/deploy.sh）不在单测范围——这里锁住其落地的领域逻辑。
 *
 * 组织图与 scripts/seed-org.ts digitalOrgPod() 同构：CEO(doer) 领两条职能线——内容与数据负责人
 * （knowledge_lead, analyst）+ 客服负责人（support_lead, guardian），岗位名与内置 playbook 委派契约对齐。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService } from '../../workforce/org-chart-service.js';
import { WorkforcePersonaBootstrapService, type WorkerPersonaSpec } from '../../workforce/workforce-persona-bootstrap-service.js';

/* 与 scripts/seed-org.ts digitalOrgPod() 同构（15 名；岗位名对齐 content_piece/data_analysis/support_ticket playbook）。 */
function digitalOrgPod(): WorkerPersonaSpec[] {
  return [
    { roleCode: 'ceo', title: '首席执行官', jobFamily: 'exec', seniority: 'exec', displayName: '齐总', personaId: 'persona-ceo', managerRoleCode: null, archetype: 'doer' },
    /* 内容与数据线（接 content_piece + data_analysis）。 */
    { roleCode: 'knowledge_lead', title: '内容与数据负责人', jobFamily: 'manager', seniority: 'lead', displayName: '析数姐', personaId: 'persona-knowledge-lead', managerRoleCode: 'ceo', archetype: 'analyst' },
    { roleCode: 'researcher_ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: '小探', personaId: 'persona-researcher-ic', managerRoleCode: 'knowledge_lead', archetype: 'explorer' },
    { roleCode: 'writer_ic', title: '撰稿人', jobFamily: 'ic', seniority: 'ic', displayName: '小文', personaId: 'persona-writer-ic', managerRoleCode: 'knowledge_lead', archetype: 'explorer' },
    { roleCode: 'reviewer_ic', title: '审核员', jobFamily: 'ic', seniority: 'ic', displayName: '小守', personaId: 'persona-reviewer-ic', managerRoleCode: 'knowledge_lead', archetype: 'guardian' },
    { roleCode: 'publisher_ic', title: '发布助理', jobFamily: 'ic', seniority: 'ic', displayName: '小发', personaId: 'persona-publisher-ic', managerRoleCode: 'knowledge_lead', archetype: 'doer' },
    { roleCode: 'analyst_lead_ic', title: '需求分析师', jobFamily: 'ic', seniority: 'ic', displayName: '小需', personaId: 'persona-analyst-lead-ic', managerRoleCode: 'knowledge_lead', archetype: 'analyst' },
    { roleCode: 'data_eng_ic', title: '数据工程师', jobFamily: 'ic', seniority: 'ic', displayName: '小数', personaId: 'persona-data-eng-ic', managerRoleCode: 'knowledge_lead', archetype: 'doer' },
    { roleCode: 'analyst_ic', title: '数据分析师', jobFamily: 'ic', seniority: 'ic', displayName: '小析', personaId: 'persona-analyst-ic', managerRoleCode: 'knowledge_lead', archetype: 'analyst' },
    { roleCode: 'reporter_ic', title: '报告撰写', jobFamily: 'ic', seniority: 'ic', displayName: '小报', personaId: 'persona-reporter-ic', managerRoleCode: 'knowledge_lead', archetype: 'explorer' },
    /* 客服线（接 support_ticket）。 */
    { roleCode: 'support_lead', title: '客服负责人', jobFamily: 'manager', seniority: 'lead', displayName: '守质哥', personaId: 'persona-support-lead', managerRoleCode: 'ceo', archetype: 'guardian' },
    { roleCode: 'triage_ic', title: '分诊专员', jobFamily: 'ic', seniority: 'ic', displayName: '小诊', personaId: 'persona-triage-ic', managerRoleCode: 'support_lead', archetype: 'guardian' },
    { roleCode: 'support_agent_ic', title: '客服专员', jobFamily: 'ic', seniority: 'ic', displayName: '小服', personaId: 'persona-support-agent-ic', managerRoleCode: 'support_lead', archetype: 'doer' },
    { roleCode: 'escalation_ic', title: '升级专员', jobFamily: 'ic', seniority: 'ic', displayName: '小升', personaId: 'persona-escalation-ic', managerRoleCode: 'support_lead', archetype: 'guardian' },
    { roleCode: 'qa_ic', title: '质检专员', jobFamily: 'ic', seniority: 'ic', displayName: '小检', personaId: 'persona-qa-ic', managerRoleCode: 'support_lead', archetype: 'analyst' },
  ];
}

const ORG = 'chrono-digital-org';

describe('K6 ADR-0056 数字员工组织 seed（一键部署落地逻辑）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;
  let svc: WorkforcePersonaBootstrapService;
  let store: OrgWorkforceStore;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 'default' });
    os.start();
    store = new OrgWorkforceStore(os.getDatabase(), 'default');
    let c = 0;
    const chart = new OrgChartService(store, () => clock.now(), () => `id-${++c}`);
    svc = new WorkforcePersonaBootstrapService(os, chart, () => clock.now());
  });
  afterEach(() => os.close());

  it('★完整组织落地★：15 名数字员工 + 全部首次出生 + 汇报关系正确', () => {
    const r = svc.bootstrap(ORG, digitalOrgPod());
    assert.equal(r.births.length, 15, '15 名员工');
    assert.ok(r.births.every((b) => b.kind === 'seeded'), '全部首次出生');
    assert.equal(store.listWorkers(ORG).length, 15, '15 名落库');
    /* CEO 是根（无上级）；两条线负责人都汇报 CEO。 */
    const ceo = r.chart.workerIdByRole.get('ceo')!;
    assert.equal(store.getManagerOf(ORG, ceo), null, 'CEO 无上级（根）');
    for (const lead of ['knowledge_lead', 'support_lead']) {
      assert.equal(store.getManagerOf(ORG, r.chart.workerIdByRole.get(lead)!), ceo, `${lead} 汇报 CEO`);
    }
    /* IC 汇报对应 lead：内容与数据线 IC 汇报 knowledge_lead，客服线 IC 汇报 support_lead。 */
    const knowledgeLead = r.chart.workerIdByRole.get('knowledge_lead')!;
    for (const ic of ['researcher_ic', 'writer_ic', 'reviewer_ic', 'publisher_ic', 'analyst_lead_ic', 'data_eng_ic', 'analyst_ic', 'reporter_ic']) {
      assert.equal(store.getManagerOf(ORG, r.chart.workerIdByRole.get(ic)!), knowledgeLead, `${ic} 汇报 knowledge_lead`);
    }
    const supportLead = r.chart.workerIdByRole.get('support_lead')!;
    for (const ic of ['triage_ic', 'support_agent_ic', 'escalation_ic', 'qa_ic']) {
      assert.equal(store.getManagerOf(ORG, r.chart.workerIdByRole.get(ic)!), supportLead, `${ic} 汇报 support_lead`);
    }
  });

  it('★4 原型齐全★：explorer/guardian/analyst/doer 都到齐（多个不同数字人格）', () => {
    const r = svc.bootstrap(ORG, digitalOrgPod());
    const archetypes = new Set(r.births.map((b) => b.archetype));
    assert.deepEqual([...archetypes].sort(), ['analyst', 'doer', 'explorer', 'guardian'], '4 原型齐全');
  });

  it('★独立认知内核★：不同原型决策风格互不相同（真不同人格）', () => {
    svc.bootstrap(ORG, digitalOrgPod());
    const explorer = os.getCore('persona-researcher-ic').decisionStyle.get();
    const guardian = os.getCore('persona-reviewer-ic').decisionStyle.get();
    const analyst = os.getCore('persona-analyst-ic').decisionStyle.get();
    const doer = os.getCore('persona-ceo').decisionStyle.get();
    /* 探索者更冒险、守护者更厌损；四种风格 JSON 不全相同。 */
    assert.ok(explorer.riskAppetite > guardian.riskAppetite, '探索者比守护者冒险');
    assert.ok(guardian.lossAversion > explorer.lossAversion, '守护者更厌损');
    const distinct = new Set([explorer, guardian, analyst, doer].map((s) => JSON.stringify(s)));
    assert.equal(distinct.size, 4, '四原型四种不同风格');
  });

  it('★可安全重跑（幂等 no-op）★：第二次 bootstrap 不重复建、不覆盖、全 skipped', () => {
    svc.bootstrap(ORG, digitalOrgPod());
    /* 让其中一名员工成长出非原型风格——重跑必须不覆盖。 */
    os.getCore('persona-researcher-ic').decisionStyle.set({ riskAppetite: 0.111 });

    const r2 = svc.bootstrap(ORG, digitalOrgPod());
    assert.ok(r2.births.every((b) => b.kind === 'skipped_existing'), '重跑全部 skipped');
    /* 组织结构未翻倍（仍 15 名，没因重复 insert 报错或留脏数据）。 */
    assert.equal(store.listWorkers(ORG).length, 15, '重跑后仍 15 名（未重复建）');
    /* 成长状态保住。 */
    assert.equal(os.getCore('persona-researcher-ic').decisionStyle.get().riskAppetite, 0.111, '成长状态未被重跑覆盖');
  });

  it('★半成品组织检测★：卷里残留同 orgId 部分结构 → chart 不覆盖全部 roleCode（seed 据此失败）', () => {
    /* 模拟脏卷：先用一个**残缺** pod（只有 CEO）建同 orgId，再用完整 pod bootstrap。 */
    const partial: WorkerPersonaSpec[] = [digitalOrgPod()[0]!]; /* 只 CEO */
    svc.bootstrap(ORG, partial);
    const r = svc.bootstrap(ORG, digitalOrgPod());
    /* bootstrapIfAbsent 复用了残缺结构（只 1 worker），chart 不覆盖完整 pod 的全部 roleCode。 */
    const expectedRoles = digitalOrgPod().map((s) => s.roleCode);
    const missing = expectedRoles.filter((rc) => !r.chart.workerIdByRole.has(rc));
    assert.ok(missing.length > 0, 'chart 不完整（缺角色）——seed CLI 的完整性校验据此 exit 1');
    assert.ok(missing.includes('researcher_ic'), '缺的角色含 researcher_ic（残缺结构只建了 CEO）');
  });

  it('★确定性可复现★：相同 pod + 时钟 → 相同出生风格', () => {
    svc.bootstrap(ORG, digitalOrgPod());
    const s1 = os.getCore('persona-knowledge-lead').decisionStyle.get();

    const clock2 = new TestClock(1000);
    const os2 = new ChronoSynthOS({ clock: clock2, logger: new SilentLogger(), tenantId: 'default' });
    os2.start();
    try {
      const store2 = new OrgWorkforceStore(os2.getDatabase(), 'default');
      let c = 0;
      const chart2 = new OrgChartService(store2, () => clock2.now(), () => `id-${++c}`);
      new WorkforcePersonaBootstrapService(os2, chart2, () => clock2.now()).bootstrap(ORG, digitalOrgPod());
      assert.deepEqual(os2.getCore('persona-knowledge-lead').decisionStyle.get(), s1, '同 pod+时钟 → 同风格');
    } finally { os2.close(); }
  });
});
