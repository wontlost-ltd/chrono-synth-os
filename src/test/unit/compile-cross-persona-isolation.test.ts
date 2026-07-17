/**
 * 安全网（缺口 #4 前置）：同租户两 persona 各编译 value_shift + memory_edge，落各自 core，互不污染。
 * 这是「收窄编译锁到 per-persona 安全」的前提证据——底层 store 隔离真成立才敢放并行。
 * 用真 ChronoSynthOS（真 CoreRhythmLayer + 真 executor），不 mock 编译目标。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('编译跨 persona 隔离（#4 安全网）', () => {
  it('value_shift：两 persona 各改各的价值权重，互不串', () => {
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const a = os.getCore('p-A');
    const b = os.getCore('p-B');
    const va = a.addValue('诚信', 0.5);
    const vb = b.addValue('诚信', 0.5);
    /* 模拟编译 value_shift：各自改各自 persona 的价值权重。 */
    a.updateValueParams(va.id, { weight: 0.9 });
    b.updateValueParams(vb.id, { weight: 0.1 });
    assert.equal([...a.values.getAll().values()].find((v) => v.id === va.id)?.weight, 0.9);
    assert.equal([...b.values.getAll().values()].find((v) => v.id === vb.id)?.weight, 0.1);
    /* A 的价值在 B 的 core 里不可见（隔离）。 */
    assert.equal([...b.values.getAll().values()].some((v) => v.id === va.id), false);
    os.close();
  });

  it('memory_edge：两 persona 各建各的记忆边，落 memory_edges 各自 persona_id，互不串', () => {
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const a = os.getCore('p-A');
    const b = os.getCore('p-B');
    const a1 = a.addMemory('semantic', 'A 的记忆1', 0, 0.7);
    const a2 = a.addMemory('semantic', 'A 的记忆2', 0, 0.7);
    const b1 = b.addMemory('semantic', 'B 的记忆1', 0, 0.7);
    const b2 = b.addMemory('semantic', 'B 的记忆2', 0, 0.7);
    a.linkMemories(a1.id, a2.id, 'relates', 0.8);
    b.linkMemories(b1.id, b2.id, 'relates', 0.8);
    /* A 的边只在 A 的 core 可见，B 的边只在 B 可见（persona_id 隔离）。 */
    assert.equal(a.memories.getAllEdges().length, 1);
    assert.equal(b.memories.getAllEdges().length, 1);
    assert.equal(a.memories.getAllEdges()[0]?.source, a1.id);
    assert.equal(b.memories.getAllEdges()[0]?.source, b1.id);
    os.close();
  });
});
