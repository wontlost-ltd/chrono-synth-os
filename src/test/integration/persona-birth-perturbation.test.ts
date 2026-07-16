/**
 * 出生 per-persona 扰动：同原型、不同 personaId 的 worker 出生即被拉开（消除"同原型逐字节相同"）。
 * 与 workforce-persona-bootstrap-k4 同 setup（OrgWorkforceStore + TestClock）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService } from '../../workforce/org-chart-service.js';
import { WorkforcePersonaBootstrapService, type WorkerPersonaSpec } from '../../workforce/workforce-persona-bootstrap-service.js';
import { personalityDiversity } from '@chrono/kernel';
import type { DecisionStyle } from '@chrono/kernel';

/** 建 N 个同原型（analyst）、不同 personaId 的 worker spec（单根 + 其余挂根，满足结构校验）。 */
function analystPod(n: number): WorkerPersonaSpec[] {
  const specs: WorkerPersonaSpec[] = [];
  for (let i = 0; i < n; i++) {
    specs.push({
      roleCode: `a${i}`, title: '分析师', jobFamily: 'ic', seniority: 'ic',
      displayName: `分析${i}`, personaId: `p-analyst-${i}`,
      managerRoleCode: i === 0 ? null : 'a0', archetype: 'analyst',
    });
  }
  return specs;
}

describe('workforce 出生 per-persona 扰动', () => {
  let os: ChronoSynthOS;
  let svc: WorkforcePersonaBootstrapService;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const store = new OrgWorkforceStore(os.getDatabase(), 't1');
    let c = 0;
    const chart = new OrgChartService(store, () => clock.now(), () => `id-${++c}`);
    svc = new WorkforcePersonaBootstrapService(os, chart, () => clock.now());
  });

  it('同原型、不同 personaId → 出生决策风格被拉开（diversityScore>0）', () => {
    svc.bootstrap('org-div', analystPod(8));
    const styles: DecisionStyle[] = [];
    for (let i = 0; i < 8; i++) styles.push(os.getCore(`p-analyst-${i}`).decisionStyle.get());
    const div = personalityDiversity(styles);
    assert.ok(div.diversityScore > 0, `同原型出生应被扰动拉开，实际 diversityScore=${div.diversityScore}`);
    /* 至少两个 persona 的 deliberationDepth 也不同（补齐第 6 维已生效）。 */
    const depths = new Set(styles.map((s) => s.deliberationDepth));
    assert.ok(depths.size >= 2, `deliberationDepth 也应分散，实得 ${[...depths]}`);
  });

  it('同 personaId 出生可复现：两个独立 OS 出生同 personaId → 决策风格逐字段相同', () => {
    svc.bootstrap('org-a', [{ roleCode: 'r', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: 'x', personaId: 'p-repro', managerRoleCode: null, archetype: 'analyst' }]);
    const first = os.getCore('p-repro').decisionStyle.get();

    const clock2 = new TestClock(1000);
    const os2 = new ChronoSynthOS({ clock: clock2, logger: new SilentLogger(), tenantId: 't2' });
    os2.start();
    const store2 = new OrgWorkforceStore(os2.getDatabase(), 't2');
    let c = 0;
    const chart2 = new OrgChartService(store2, () => clock2.now(), () => `id-${++c}`);
    const svc2 = new WorkforcePersonaBootstrapService(os2, chart2, () => clock2.now());
    svc2.bootstrap('org-a', [{ roleCode: 'r', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: 'x', personaId: 'p-repro', managerRoleCode: null, archetype: 'analyst' }]);
    const second = os2.getCore('p-repro').decisionStyle.get();

    assert.deepEqual(
      { r: first.riskAppetite, t: first.timeHorizon, e: first.explorationBias, d: first.deliberationDepth, l: first.lossAversion, g: first.regretSensitivity },
      { r: second.riskAppetite, t: second.timeHorizon, e: second.explorationBias, d: second.deliberationDepth, l: second.lossAversion, g: second.regretSensitivity },
    );
    os2.close();
  });
});
