/**
 * 性格出生随机化生产接线（③）：ChronoSynthOS.personalitySeed 在 start() 扰动决策风格。
 *
 * 验证：① 无 seed → 默认（向后兼容）；② 同 seed → 同性格；③ 不同 seed → 不同性格（出生即不同）；
 * ④ 已演化的 persona（updatedAt≠0）重启不被重新扰动；⑤ 用①度量验证一批不同 seed 真拉开多样性。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { createMemoryDatabase } from '../../storage/index.js';
import { personalityDiversity, DEFAULT_DECISION_STYLE } from '@chrono/kernel';
import type { DecisionStyle } from '@chrono/kernel';

describe('性格出生随机化生产接线（③）', () => {
  const instances: ChronoSynthOS[] = [];
  function makeOS(personalitySeed?: { seed: string; magnitude: number }): ChronoSynthOS {
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), personalitySeed });
    os.start();
    instances.push(os);
    return os;
  }
  afterEach(() => { while (instances.length) instances.pop()!.close(); });

  function style(os: ChronoSynthOS): DecisionStyle {
    return os.core.getState().decisionStyle;
  }

  it('无 personalitySeed → 决策风格仍为默认（向后兼容）', () => {
    const s = style(makeOS());
    assert.equal(s.riskAppetite, DEFAULT_DECISION_STYLE.riskAppetite);
    assert.equal(s.deliberationDepth, DEFAULT_DECISION_STYLE.deliberationDepth);
    assert.equal(s.updatedAt, 0, '未被写过（默认 updatedAt=0）');
  });

  it('magnitude=0 → 不扰动（仍默认）', () => {
    const s = style(makeOS({ seed: 'persona_1', magnitude: 0 }));
    assert.equal(s.riskAppetite, DEFAULT_DECISION_STYLE.riskAppetite);
    assert.equal(s.updatedAt, 0);
  });

  it('同 seed → 同性格（可复现）', () => {
    const a = style(makeOS({ seed: 'persona_1', magnitude: 0.3 }));
    const b = style(makeOS({ seed: 'persona_1', magnitude: 0.3 }));
    assert.equal(a.riskAppetite, b.riskAppetite);
    assert.equal(a.deliberationDepth, b.deliberationDepth);
    assert.equal(a.lossAversion, b.lossAversion);
  });

  it('不同 seed → 不同性格（出生即不同）', () => {
    const a = style(makeOS({ seed: 'persona_1', magnitude: 0.3 }));
    const b = style(makeOS({ seed: 'persona_2', magnitude: 0.3 }));
    assert.notDeepEqual(
      [a.riskAppetite, a.timeHorizon, a.explorationBias],
      [b.riskAppetite, b.timeHorizon, b.explorationBias],
    );
    /* 扰动后 updatedAt 被写（≠0）。 */
    assert.notEqual(a.updatedAt, 0);
  });

  it('同 DB 重启不重扰（即使 clock=0）：第二次 start 不覆盖第一次的出生风格（Codex 复审）', () => {
    /* TestClock(0)：暴露原 updatedAt===0 守卫 bug——扰动写的 updatedAt 仍是 0，若守卫看 updatedAt
     * 会误判「未演化」而重扰。改用 row 存在性守卫后，重启不漂移。
     * 共享 db：第二个 OS 用 skipMigrations 复用同库，且不 close os1（os.close 会关 db）。 */
    const db = createMemoryDatabase();
    const os1 = new ChronoSynthOS({ db, clock: new TestClock(0), logger: new SilentLogger(), personalitySeed: { seed: 'p1', magnitude: 0.3 } });
    os1.start();
    const first = { ...style(os1) };
    /* 同 db 第二个 OS（模拟进程重启，复用持久态），同 seed → 不应重扰。 */
    const os2 = new ChronoSynthOS({ db, clock: new TestClock(0), logger: new SilentLogger(), skipMigrations: true, personalitySeed: { seed: 'p1', magnitude: 0.3 } });
    os2.start();
    assert.deepEqual({ ...style(os2) }, first, '重启不重扰，出生风格保留');
    db.close();
  });

  it('已演化 persona 不被出生扰动覆盖（手动 set 后重启带 seed → 保留演化值）', () => {
    const db = createMemoryDatabase();
    const os1 = new ChronoSynthOS({ db, clock: new TestClock(1000), logger: new SilentLogger() });
    os1.start();
    os1.core.setDecisionStyle({ riskAppetite: 0.9 }); /* 演化：写了 row */
    /* 同 db 带 seed 重启（skipMigrations 复用库）→ exists() 已 true → 不扰动 → 保留 0.9。 */
    const os2 = new ChronoSynthOS({ db, clock: new TestClock(1000), logger: new SilentLogger(), skipMigrations: true, personalitySeed: { seed: 'x', magnitude: 0.5 } });
    os2.start();
    assert.equal(style(os2).riskAppetite, 0.9, '已演化值未被出生扰动改写');
    db.close();
  });

  it('用①度量验证：一批不同 seed 的 persona → diversityScore > 0（真拉开多样性）', () => {
    const batch: DecisionStyle[] = [];
    for (let i = 0; i < 30; i++) batch.push(style(makeOS({ seed: `p_${i}`, magnitude: 0.3 })));
    assert.ok(personalityDiversity(batch).diversityScore > 0, '出生即被随机化拉开');
  });
});
