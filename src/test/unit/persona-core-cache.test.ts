import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaCoreCache } from '../../core/persona-core-cache.js';

/** 注入式假时钟：可手动推进，验证 TTL 而不依赖真实时间（可复现）。 */
function fakeClock(start = 1_000): { now(): number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('PersonaCoreCache（personaCores 驱逐）', () => {
  it('未超容量时不驱逐，返回同一实例（零回归）', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 4 });
    c.set('a', 'A'); c.set('b', 'B');
    assert.equal(c.get('a'), 'A');
    assert.equal(c.get('b'), 'B');
    assert.equal(c.stats().size, 2);
    assert.equal(c.stats().evictions, 0);
  });

  it('超容量驱逐最久未访问项（LRU 顺序）', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 2 });
    c.set('a', 'A'); c.set('b', 'B');
    c.get('a');            // a 变最近 → b 最久未访问
    c.set('c', 'C');       // 触发驱逐 → 应逐 b
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 'A');
    assert.equal(c.get('c'), 'C');
    assert.equal(c.stats().evictions, 1);
  });

  it('pin 的 key 永不被容量驱逐', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 2 });
    c.set('default', 'D'); c.pin('default');
    c.set('a', 'A');
    c.set('b', 'B');       // 已有 default(pin)+a → 加 b 触发驱逐，只能逐 a（default 免疫）
    c.set('c', 'C');       // 再逐 b
    assert.equal(c.get('default'), 'D');   // pin 项恒在
    assert.equal(c.stats().pinned, 1);
  });

  it('TTL 启用时，过期的非 pin 项在下次 get 视为 miss；pin 项不过期', () => {
    const clk = fakeClock();
    const c = new PersonaCoreCache<string>(clk, { max: 10, ttlMs: 100 });
    c.set('default', 'D'); c.pin('default');
    c.set('a', 'A');
    clk.advance(50);
    assert.equal(c.get('a'), 'A');         // 未过期
    clk.advance(101);                      // a 上次访问后 > 100ms
    assert.equal(c.get('a'), undefined);   // 过期 miss
    assert.equal(c.get('default'), 'D');   // pin 不过期
  });

  it('max<=0 表示无上限（禁用容量驱逐）', () => {
    const c = new PersonaCoreCache<string>(fakeClock(), { max: 0 });
    for (let i = 0; i < 100; i++) c.set(`k${i}`, `v${i}`);
    assert.equal(c.stats().size, 100);
    assert.equal(c.stats().evictions, 0);
  });

  it('has 探测不影响 LRU 顺序、不触发 TTL 删除', () => {
    const clk = fakeClock();
    const c = new PersonaCoreCache<string>(clk, { max: 2, ttlMs: 100 });
    c.set('a', 'A'); c.set('b', 'B');
    clk.advance(200);
    assert.equal(c.has('a'), true);        // 探测：即便逻辑过期，has 仍报告存在（不删）
    assert.equal(c.stats().size, 2);
  });
});
