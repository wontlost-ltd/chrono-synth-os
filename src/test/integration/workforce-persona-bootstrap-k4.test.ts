/**
 * K4（ADR-0056）数字员工人格出生——bootstrap 组织时每 worker 套不同原型，各有独立人格内核。
 *
 * 验证：bootstrap 一个 4 原型小队 → 每 worker 一个独立 persona core，套各自原型的出生决策风格，互不相同；
 * 幂等（再 bootstrap 不覆盖已成长状态）；组织结构正确建出。这是「包含多个不同数字人格」的真出生流程。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService } from '../../workforce/org-chart-service.js';
import { WorkforcePersonaBootstrapService, type WorkerPersonaSpec } from '../../workforce/workforce-persona-bootstrap-service.js';

describe('K4 ADR-0056 数字员工人格出生（多原型独立内核）', () => {
  let os: ChronoSynthOS;
  let svc: WorkforcePersonaBootstrapService;
  let clock: TestClock;

  /* 4 原型小队：主管(doer) + 探索研究(explorer) + 守护审核(guardian) + 分析(analyst)。 */
  function pod(): WorkerPersonaSpec[] {
    return [
      { roleCode: 'manager', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管阿杜', personaId: 'p-manager', managerRoleCode: null, archetype: 'doer' },
      { roleCode: 'researcher', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: '研究阿探', personaId: 'p-researcher', managerRoleCode: 'manager', archetype: 'explorer' },
      { roleCode: 'reviewer', title: '审核员', jobFamily: 'ic', seniority: 'ic', displayName: '审核阿守', personaId: 'p-reviewer', managerRoleCode: 'manager', archetype: 'guardian' },
      { roleCode: 'analyst', title: '分析师', jobFamily: 'ic', seniority: 'ic', displayName: '分析阿析', personaId: 'p-analyst', managerRoleCode: 'manager', archetype: 'analyst' },
    ];
  }

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const store = new OrgWorkforceStore(os.getDatabase(), 't1');
    let c = 0;
    const chart = new OrgChartService(store, () => clock.now(), () => `id-${++c}`);
    svc = new WorkforcePersonaBootstrapService(os, chart, () => clock.now());
  });

  it('★多原型独立内核★：4 worker 各套不同原型，决策风格互不相同', () => {
    const r = svc.bootstrap('org-1', pod());
    assert.equal(r.births.length, 4);
    assert.ok(r.births.every((b) => b.kind === 'seeded'), '全部首次出生');
    /* 每 worker 的独立 core 读回各自原型风格。 */
    const explorer = os.getCore('p-researcher').decisionStyle.get();
    const guardian = os.getCore('p-reviewer').decisionStyle.get();
    /* explorer: explorationBias↑ riskAppetite↑；guardian: riskAppetite↓ lossAversion↑。 */
    assert.ok(explorer.riskAppetite > guardian.riskAppetite, '探索者比守护者更冒险');
    assert.ok(explorer.explorationBias > guardian.explorationBias, '探索者探索偏好更高');
    assert.ok(guardian.lossAversion > explorer.lossAversion, '守护者更厌恶损失');
  });

  it('★4 原型两两不同★：4 个 persona 的决策风格四种全不同（真多样）', () => {
    svc.bootstrap('org-1', pod());
    const styles = ['p-manager', 'p-researcher', 'p-reviewer', 'p-analyst']
      .map((pid) => JSON.stringify(os.getCore(pid).decisionStyle.get()));
    const distinct = new Set(styles);
    assert.equal(distinct.size, 4, `4 原型应四种全不同风格（实得 ${distinct.size}）`);
  });

  it('★同原型多实例★：两 worker 同 explorer 但 personaId 不同 → 各自独立 core，都出生', () => {
    /* archetype 是模板、personaId 是实例身份（ADR D0.1）：一个 archetype 可多实例。 */
    const r = svc.bootstrap('org-2', [
      { roleCode: 'scout-a', title: '斥候A', jobFamily: 'ic', seniority: 'ic', displayName: '斥候甲', personaId: 'p-scout-a', managerRoleCode: null, archetype: 'explorer' },
      { roleCode: 'scout-b', title: '斥候B', jobFamily: 'ic', seniority: 'ic', displayName: '斥候乙', personaId: 'p-scout-b', managerRoleCode: 'scout-a', archetype: 'explorer' },
    ]);
    assert.ok(r.births.every((b) => b.kind === 'seeded'), '两实例都首次出生');
    const a = os.getCore('p-scout-a');
    const b = os.getCore('p-scout-b');
    assert.notStrictEqual(a, b, '不同 personaId → 不同 core 实例');
    /* 同原型 → 出生风格相同（模板一致），但是写入两行独立。 */
    assert.deepEqual(a.decisionStyle.get(), b.decisionStyle.get(), '同原型出生风格一致');
    /* 各自独立成长互不影响。 */
    a.decisionStyle.set({ riskAppetite: 0.5 });
    assert.notEqual(a.decisionStyle.get().riskAppetite, b.decisionStyle.get().riskAppetite, '成长后各自独立');
  });

  it('★幂等·仅叙事已写也不覆盖★：persona 有 narrative 但无 decision_style → skipped，不覆盖叙事', () => {
    /* 防 PR #159 同构坑：只看 decisionStyle.exists() 会漏判已写叙事的 persona，覆盖其成长后叙事。 */
    os.getCore('p-researcher').narrative.set('我是已成长的研究员，记得很多事');
    const r = svc.bootstrap('org-1', pod());
    const researcherOutcome = r.births.find((b) => b.personaId === 'p-researcher')!;
    assert.equal(researcherOutcome.kind, 'skipped_existing', '已有叙事 → 不覆盖');
    assert.equal(os.getCore('p-researcher').narrative.get(), '我是已成长的研究员，记得很多事', '叙事保住');
    /* decision_style 未被 seed（幂等整体跳过该 persona）。 */
    assert.equal(os.getCore('p-researcher').decisionStyle.exists(), false, '跳过的 persona 不写决策风格');
  });

  it('★出生叙事★：每 worker 有原型化自我叙事', () => {
    svc.bootstrap('org-1', pod());
    assert.match(os.getCore('p-researcher').narrative.get(), /探索者/);
    assert.match(os.getCore('p-reviewer').narrative.get(), /守护者/);
  });

  it('★幂等不覆盖成长★：已有决策风格的 persona 再 bootstrap → skipped，不覆盖', () => {
    /* 先让 researcher 成长出一个非原型风格。 */
    os.getCore('p-researcher').decisionStyle.set({ riskAppetite: 0.123 });
    const r = svc.bootstrap('org-1', pod());
    const researcherOutcome = r.births.find((b) => b.personaId === 'p-researcher')!;
    assert.equal(researcherOutcome.kind, 'skipped_existing', '已成长 → 不覆盖');
    assert.equal(os.getCore('p-researcher').decisionStyle.get().riskAppetite, 0.123, '成长状态保住');
    /* 其余未成长的仍正常出生。 */
    assert.equal(r.births.find((b) => b.personaId === 'p-reviewer')!.kind, 'seeded');
  });

  it('★组织结构建出★：bootstrap 同时建好 4 worker + 汇报关系', () => {
    const r = svc.bootstrap('org-1', pod());
    assert.equal(r.chart.workerIdByRole.size, 4);
    const store = new OrgWorkforceStore(os.getDatabase(), 't1');
    assert.equal(store.listWorkers('org-1').length, 4);
    assert.equal(store.getManagerOf('org-1', r.chart.workerIdByRole.get('researcher')!), r.chart.workerIdByRole.get('manager'));
  });

  it('★原子性·结构非法整体回滚★：上级不存在 → 抛错（落库前校验），组织不落库', () => {
    /* 结构非法（上级 ghost 不存在）→ orgChart 落库前内存校验抛错；既无组织行，也未进人格出生。 */
    const bad: WorkerPersonaSpec[] = [
      { roleCode: 'lead', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-bad-lead', managerRoleCode: null, archetype: 'doer' },
      { roleCode: 'orphan', title: '孤儿', jobFamily: 'ic', seniority: 'ic', displayName: '孤儿', personaId: 'p-bad-orphan', managerRoleCode: 'ghost', archetype: 'explorer' },
    ];
    assert.throws(() => svc.bootstrap('org-bad', bad), /ghost|上级|不存在|非法/);
    const store = new OrgWorkforceStore(os.getDatabase(), 't1');
    assert.equal(store.listWorkers('org-bad').length, 0, '组织未落库');
    assert.equal(os.getCore('p-bad-lead').decisionStyle.exists(), false, '未进人格出生');
  });

  it('★原子性·人格出生中途失败整体回滚★：第 2 个 worker 出生抛错 → 组织 + 第 1 人格都回滚', () => {
    /* 真正验事务：组织已建、第 1 worker 已出生后，第 2 worker 出生抛错 → 整事务回滚。
     * 用一个第 2 次调用即抛的 now() 注入「出生中途失败」（出生时每 worker 调一次 this.now()）。 */
    let calls = 0;
    const throwingNow = (): number => {
      calls++;
      if (calls === 2) throw new Error('注入：第 2 个 worker 出生失败');
      return 1000;
    };
    const store0 = new OrgWorkforceStore(os.getDatabase(), 't1');
    let c = 0;
    const chart0 = new OrgChartService(store0, () => 1000, () => `idx-${++c}`);
    const failSvc = new WorkforcePersonaBootstrapService(os, chart0, throwingNow);
    const two: WorkerPersonaSpec[] = [
      { roleCode: 'lead', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-atom-lead', managerRoleCode: null, archetype: 'doer' },
      { roleCode: 'ic', title: '员工', jobFamily: 'ic', seniority: 'ic', displayName: '员工', personaId: 'p-atom-ic', managerRoleCode: 'lead', archetype: 'explorer' },
    ];
    assert.throws(() => failSvc.bootstrap('org-atom', two), /出生失败/);
    /* 组织行回滚（orgChart 写入也在同一事务里）。 */
    assert.equal(store0.listWorkers('org-atom').length, 0, '组织随事务回滚');
    /* 第 1 个 worker 已写入决策风格，但事务回滚 → 不应残留。 */
    assert.equal(os.getCore('p-atom-lead').decisionStyle.exists(), false, '第 1 人格出生随事务回滚');
  });

  it('★确定性可复现★：相同 pod + 时钟 → 相同出生风格', () => {
    svc.bootstrap('org-1', pod());
    const s1 = os.getCore('p-researcher').decisionStyle.get();
    /* 全新 os 重跑。 */
    const clock2 = new TestClock(1000);
    const os2 = new ChronoSynthOS({ clock: clock2, logger: new SilentLogger(), tenantId: 't1' });
    os2.start();
    try {
      const store2 = new OrgWorkforceStore(os2.getDatabase(), 't1');
      let c = 0;
      const chart2 = new OrgChartService(store2, () => clock2.now(), () => `id-${++c}`);
      new WorkforcePersonaBootstrapService(os2, chart2, () => clock2.now()).bootstrap('org-1', pod());
      const s2 = os2.getCore('p-researcher').decisionStyle.get();
      assert.deepEqual(s1, s2, '同 pod+时钟 → 同出生风格');
    } finally { os2.close(); }
  });
});
