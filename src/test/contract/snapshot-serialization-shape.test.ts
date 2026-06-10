/**
 * 真实形态契约锁（WP-3 T3.2）：快照序列化的 Map 往返。
 *
 * 本周 Critical 教训：`coreSelf.values` 是 `Map`，naive `JSON.stringify` 会把 Map 变成 `{}`
 * （**静默全量丢失**所有核心价值），快照恢复后人格被清空。deepStringify/deepParse 用
 * `__type:'Map'` 标记往返解决此问题。这是唯一防线，必须有回归测试把坑钉死。
 *
 * 锁两件事：
 *   1. deep 往返**保真**真实快照形态（嵌套 Map、Map of object）。
 *   2. naive JSON.stringify **确实会丢** Map —— 证明 deepStringify 不可省（防止有人「优化」掉它）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepStringify, deepParse } from '../../storage/serialization.js';

/** 贴近真实 coreSelf.values 形态：Map<valueId, CoreValue-ish object>。 */
function realValuesMap(): Map<string, { id: string; label: string; weight: number }> {
  return new Map([
    ['research', { id: 'research', label: '探索', weight: 0.46 }],
    ['stability', { id: 'stability', label: '稳定', weight: 0.5 }],
  ]);
}

describe('快照序列化形态契约（WP-3 T3.2）', () => {
  it('deep 往返保真：Map<string, object> 不丢键、不丢值、类型仍是 Map', () => {
    const values = realValuesMap();
    const restored = deepParse<Map<string, { id: string; label: string; weight: number }>>(deepStringify(values));
    assert.ok(restored instanceof Map, '恢复后必须仍是 Map（不是普通对象）');
    assert.equal(restored.size, 2, '不能丢键');
    assert.deepEqual(restored.get('research'), { id: 'research', label: '探索', weight: 0.46 });
    assert.deepEqual(restored.get('stability'), { id: 'stability', label: '稳定', weight: 0.5 });
  });

  it('deep 往返保真：嵌套快照形态（coreSelf.values 在对象树里）', () => {
    const snapshotLike = {
      id: 'snap_1',
      coreSelf: { values: realValuesMap(), narrative: '我在探索' },
      createdAt: 1000,
    };
    const restored = deepParse<typeof snapshotLike>(deepStringify(snapshotLike));
    assert.ok(restored, '解析不应失败');
    assert.ok(restored!.coreSelf.values instanceof Map, '嵌套 Map 必须恢复为 Map');
    assert.equal(restored!.coreSelf.values.size, 2);
    assert.equal(restored!.coreSelf.narrative, '我在探索');
  });

  it('回归钉死：naive JSON.stringify 会把 Map 变成 {}（全量丢失）—— 故 deepStringify 不可省', () => {
    const values = realValuesMap();
    /* 这正是本周踩的坑：直接 JSON.stringify 一个含 Map 的对象。 */
    const naive = JSON.parse(JSON.stringify({ values }));
    assert.deepEqual(naive.values, {}, 'naive stringify 把 Map 序列化为空对象（数据全丢）');
    assert.equal(Object.keys(naive.values).length, 0, '所有 valueId 都丢了');

    /* 对照：deep 往返没丢。 */
    const deep = deepParse<{ values: Map<string, unknown> }>(deepStringify({ values }));
    assert.equal(deep!.values.size, 2, 'deep 往返保住了全部 value');
  });

  it('deepParse 容错：畸形 JSON 返回 null，不抛（下游可稳定降级）', () => {
    assert.equal(deepParse('{not valid json'), null);
    assert.equal(deepParse(''), null);
  });

  it('空 Map 往返仍是空 Map（不退化成 null/undefined）', () => {
    const restored = deepParse<Map<string, unknown>>(deepStringify(new Map()));
    assert.ok(restored instanceof Map);
    assert.equal(restored.size, 0);
  });
});
