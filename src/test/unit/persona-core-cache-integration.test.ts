import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';

/* 用小容量 personaCoreCache 驱动 ChronoSynthOS 层的驱逐不变量。 */
describe('ChronoSynthOS personaCores 驱逐接入', () => {
  it("'default' 永不被驱逐，this.core 恒等于 getCore('default')", () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 2 } });
    const defaultCore = os.getCore('default');
    assert.equal(os.core, defaultCore);
    /* 塞入多个 persona 触发驱逐（max=2，default 被 pin 不占额度） */
    for (let i = 0; i < 5; i++) os.getCore(`p${i}`);
    /* default 仍是同一活实例 */
    assert.equal(os.getCore('default'), defaultCore);
    assert.equal(os.core, defaultCore);
    os.close();
  });

  it('驱逐后重取，DB 态一致（write-through 零数据丢失）', () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 1 } });
    /* 给 p1 写一条价值 */
    const p1 = os.getCore('p1');
    p1.addValue('诚信', 0.9);
    /* 访问其它 persona 把 p1 挤出缓存（max=1，default 已 pin 占 map 但不占驱逐额度→p1 会被逐） */
    os.getCore('p2');
    os.getCore('p3');
    /* 重新取 p1（重建实例），读回 DB 态 */
    const p1again = os.getCore('p1');
    const values = [...p1again.values.getAll().values()];
    assert.equal(values.some((v) => v.label === '诚信'), true);
    os.close();
  });

  it('容量足够时零回归：同 personaId 返回同实例', () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 512 } });
    const a1 = os.getCore('a');
    const a2 = os.getCore('a');
    assert.equal(a1, a2);
    os.close();
  });

  it('personaCoreCacheStats 可观测', () => {
    const os = new ChronoSynthOS({ personaCoreCache: { max: 2 } });
    os.getCore('x'); os.getCore('y'); os.getCore('z');
    const s = os.personaCoreCacheStats();
    assert.ok(s.evictions >= 1);
    assert.ok(s.pinned >= 1);   // default 被 pin
    os.close();
  });
});
