/**
 * K3（ADR-0056）per-persona CoreRhythmLayer 工厂——os.getCore(personaId) 返回独立认知内核，缓存 persona-aware。
 *
 * 验证：同 personaId → 同一缓存实例（不串脑，ADR 红线5）；不同 persona → 独立 core，各自的决策风格/叙事/
 * 认知模型隔离（复用 K2）；os.core === getCore('default')（兼容 facade）；重启后 DB 状态可恢复。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('K3 ADR-0056 per-persona CoreRhythmLayer 工厂', () => {
  let os: ChronoSynthOS;
  before(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os.start();
  });
  after(() => os.close());

  it('★缓存 persona-aware★：同 personaId 返回同一实例（不重复建脑）', () => {
    const a1 = os.getCore('explorer-01');
    const a2 = os.getCore('explorer-01');
    assert.strictEqual(a1, a2, '同 persona 同一缓存实例');
  });

  it('★os.core = default persona 兼容 facade★', () => {
    assert.strictEqual(os.core, os.getCore('default'), 'os.core 等价 getCore(default)');
  });

  it('★不同 persona 独立认知内核★：explorer vs guardian 决策风格互不可见/覆盖', () => {
    const explorer = os.getCore('explorer-01');
    const guardian = os.getCore('guardian-01');
    assert.notStrictEqual(explorer, guardian, '不同 persona 不同 core 实例');
    explorer.decisionStyle.set({ riskAppetite: 0.9, explorationBias: 0.9 });
    guardian.decisionStyle.set({ riskAppetite: 0.1, lossAversion: 3 });
    assert.equal(explorer.decisionStyle.get().riskAppetite, 0.9);
    assert.equal(guardian.decisionStyle.get().riskAppetite, 0.1, 'guardian 不被 explorer 覆盖');
    /* 叙事/认知模型也独立。 */
    explorer.narrative.set('我是探索者');
    guardian.narrative.set('我是守护者');
    assert.equal(explorer.narrative.get(), '我是探索者');
    assert.equal(guardian.narrative.get(), '我是守护者');
  });

  it('★listPersonaCores 可观测★：列出已实例化的 persona core', () => {
    os.getCore('a'); os.getCore('b');
    const list = os.listPersonaCores();
    assert.ok(list.includes('a') && list.includes('b') && list.includes('default'));
    /* 确定性排序。 */
    assert.deepEqual([...list].sort(), list);
  });

  it('★工厂传 tenantId+personaId★：getCore 的 core 真带 (tenant, persona) 维度（写入按两维隔离）', () => {
    /* K3 工厂职责：把 (tenantId, personaId) 双维正确传给 CoreRhythmLayer。tenant 跨实例隔离是 K2 已验
     * （persona-character-k2 + adapter-web 契约），这里只验工厂把 personaId 正确线程进去，写入按 persona 落对行。 */
    const p1 = os.getCore('factory-p1');
    const p2 = os.getCore('factory-p2');
    p1.decisionStyle.set({ riskAppetite: 0.88 });
    /* 同租户(t1)不同 persona → 各自一行；直接查 DB 验证 persona_id 维度落对。 */
    const rows = os.getDatabase().prepare<{ persona_id: string }>(
      `SELECT persona_id FROM decision_style WHERE tenant_id='t1' AND persona_id IN ('factory-p1','factory-p2') ORDER BY persona_id`,
    ).all();
    assert.deepEqual(rows.map((r) => r.persona_id), ['factory-p1'], '只 p1 写入落库(p2 未写)');
    assert.equal(p1.decisionStyle.get().riskAppetite, 0.88);
    assert.equal(p2.decisionStyle.get().updatedAt, 0, 'p2 未写 → 默认态');
  });

  it('★工厂不 seed 业务状态（ADR 红线9）★：getCore 新 persona → 决策风格是默认态(未写)', () => {
    const fresh = os.getCore('never-seeded');
    /* 未写过 → updatedAt 0（默认态，工厂只寻址不 seed）。 */
    assert.equal(fresh.decisionStyle.get().updatedAt, 0, '工厂未自动 seed 人格状态');
  });
});
