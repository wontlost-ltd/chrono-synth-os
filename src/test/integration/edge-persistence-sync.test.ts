/**
 * 端侧持久化 + 同步边界（ADR-0052 Edge-P3）：端侧人格状态可落盘+重载+replay 一致；本地变更入
 * outbox；多设备冲突按三分法解决——**身份核冲突绝不 last-write-wins**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryValueUnitOfWork, DeterministicClock, DeterministicRandom,
  InMemoryPersistence, SyncOutbox, resolveConflict, resolveConflictsByTarget, toChangeRef,
  type ChangeRef,
} from '../../edge/index.js';
import { createValue, getAllValues } from '@chrono/kernel';

describe('端侧持久化往返（ADR-0052 Edge-P3）', () => {
  it('序列化 → 落盘 → 重载 → 状态 hash 一致', async () => {
    const tx = new InMemoryValueUnitOfWork();
    const clock = new DeterministicClock();
    const random = new DeterministicRandom();
    createValue(tx, clock, random, '探索', 0.5);
    createValue(tx, clock, random, '稳定', 0.6);
    const beforeHash = tx.snapshotHash();

    /* 落盘。 */
    const disk = new InMemoryPersistence();
    await disk.save('persona:values', tx.serialize());

    /* 新设备/重启：从盘重建。 */
    const restored = new InMemoryValueUnitOfWork();
    const loaded = await disk.load('persona:values');
    assert.ok(loaded);
    restored.restore(loaded!);

    assert.equal(restored.snapshotHash(), beforeHash, '重载后状态 hash 必须一致');
    assert.equal(getAllValues(restored).size, 2);
  });

  it('序列化确定性：同状态 → 同序列化字符串', () => {
    const a = new InMemoryValueUnitOfWork();
    const b = new InMemoryValueUnitOfWork();
    const c = new DeterministicClock();
    const r = new DeterministicRandom();
    createValue(a, c, r, 'X', 0.5);
    const c2 = new DeterministicClock();
    const r2 = new DeterministicRandom();
    createValue(b, c2, r2, 'X', 0.5);
    assert.equal(a.serialize(), b.serialize());
  });

  it('restore 畸形输入抛错（不静默丢状态）', () => {
    const tx = new InMemoryValueUnitOfWork();
    assert.throws(() => tx.restore('{"rows":"not-array"}'), /rows 必须是数组/);
  });

  it('schemaVersion（收口）：序列化带版本，兼容早期裸数组，拒未知版本', () => {
    const tx = new InMemoryValueUnitOfWork();
    const clock = new DeterministicClock();
    const random = new DeterministicRandom();
    createValue(tx, clock, random, 'X', 0.5);
    /* 序列化带 schemaVersion。 */
    assert.equal(JSON.parse(tx.serialize()).schemaVersion, 1);
    /* 向后兼容早期裸数组格式。 */
    const legacy = new InMemoryValueUnitOfWork();
    legacy.restore(JSON.stringify([{ id: 'v1', label: 'x', weight: 0.5, timeDiscount: 0.5, emotionAmplifier: 1, updatedAt: 1 }]));
    assert.equal(getAllValues(legacy).size, 1, '裸数组兼容为 v1');
    /* 拒未知版本。 */
    assert.throws(() => legacy.restore(JSON.stringify({ schemaVersion: 99, rows: [] })), /不支持的 schemaVersion/);
  });

  it('restore 原子性：数组内含畸形行 → 抛错且不破坏现有状态', () => {
    const tx = new InMemoryValueUnitOfWork();
    const clock = new DeterministicClock();
    const random = new DeterministicRandom();
    createValue(tx, clock, random, '基线', 0.5);
    const before = tx.snapshotHash();
    /* 第二行缺 id（畸形）。 */
    const bad = JSON.stringify([
      { id: 'v1', label: 'ok', weight: 0.5, timeDiscount: 0.5, emotionAmplifier: 1, updatedAt: 1 },
      { label: 'missing-id', weight: 0.5, timeDiscount: 0.5, emotionAmplifier: 1, updatedAt: 1 },
    ]);
    assert.throws(() => tx.restore(bad), /畸形价值行/);
    assert.equal(tx.snapshotHash(), before, '畸形 restore 不破坏现有状态（原子）');
  });

  it('restore 领域约束：非法 weight（>1）被拒（不注入非法状态）', () => {
    const tx = new InMemoryValueUnitOfWork();
    const illegal = JSON.stringify([
      { id: 'v1', label: 'x', weight: 999, timeDiscount: 0.5, emotionAmplifier: 1, updatedAt: 1 },
    ]);
    assert.throws(() => tx.restore(illegal), /畸形价值行/);
    assert.equal(getAllValues(tx).size, 0, '非法状态未注入');
  });

  it('restore 领域约束：emotionAmplifier 越界（>2.0）被拒（对齐 value-service [0.5,2.0]）', () => {
    const tx = new InMemoryValueUnitOfWork();
    const illegal = JSON.stringify([
      { id: 'v1', label: 'x', weight: 0.5, timeDiscount: 0.5, emotionAmplifier: 999, updatedAt: 1 },
    ]);
    assert.throws(() => tx.restore(illegal), /畸形价值行/);
    /* 合法 emotionAmplifier=1.5 应通过。 */
    tx.restore(JSON.stringify([{ id: 'v1', label: 'x', weight: 0.5, timeDiscount: 0.5, emotionAmplifier: 1.5, updatedAt: 1 }]));
    assert.equal(getAllValues(tx).size, 1);
  });
});

describe('同步 outbox（ADR-0052 Edge-P3）', () => {
  it('本地变更入队，分配单调 seq', () => {
    const ob = new SyncOutbox('device-A');
    const e1 = ob.enqueue('fact', 'memory.append', { id: 'm1' }, 1000);
    const e2 = ob.enqueue('fact', 'memory.append', { id: 'm2' }, 2000);
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(ob.pending().length, 2);
  });

  it('markSynced 移出 pending', () => {
    const ob = new SyncOutbox('device-A');
    ob.enqueue('fact', 'memory.append', { id: 'm1' }, 1000);
    ob.enqueue('fact', 'memory.append', { id: 'm2' }, 2000);
    assert.equal(ob.markSynced(1), true);
    assert.equal(ob.pending().length, 1);
    assert.equal(ob.pending()[0].seq, 2);
    assert.equal(ob.markSynced(99), false);
  });

  it('序列化往返：重载后 nextSeq 续接（不破坏 seq 去重锚点）', () => {
    const ob = new SyncOutbox('device-A');
    ob.enqueue('fact', 'memory.append', { id: 'm1' }, 1000);
    ob.enqueue('fact', 'memory.append', { id: 'm2' }, 2000);
    /* 落盘重载。 */
    const restored = SyncOutbox.fromSerialized(ob.serialize());
    const e3 = restored.enqueue('fact', 'memory.append', { id: 'm3' }, 3000);
    assert.equal(e3.seq, 3, '重载后 seq 续接（非从 1 重来）');
    assert.equal(restored.all().length, 3);
  });

  it('schemaVersion（收口）：outbox 序列化带版本，拒未知版本', () => {
    const ob = new SyncOutbox('A');
    ob.enqueue('fact', 'memory.append', { id: 'm1' }, 1000);
    assert.equal(JSON.parse(ob.serialize()).schemaVersion, 1);
    assert.throws(
      () => SyncOutbox.fromSerialized(JSON.stringify({ schemaVersion: 99, deviceId: 'A', nextSeq: 1, entries: [] })),
      /不支持的 schemaVersion/,
    );
  });

  it('防误标护栏：真实 kernel 身份核 op（core-value.*）标成 fact → enqueue 抛错', () => {
    const ob = new SyncOutbox('device-A');
    /* 真实 kernel kind 是 core-value.update（非 value.update）；标成 fact → 拦截。 */
    assert.throws(() => ob.enqueue('fact', 'core-value.update', { id: 'v1' }, 1000), /防身份核误标/);
    /* 正确标 identity → 通过。 */
    const e = ob.enqueue('identity', 'core-value.update', { id: 'v1' }, 1000);
    assert.equal(e.changeClass, 'identity');
  });

  it('身份核前缀覆盖真实 kernel kind（core-value/survival-anchor/narrative/decision-style/cognitive-model/personaRule）', () => {
    const ob = new SyncOutbox('device-A');
    for (const op of ['core-value.update', 'survival-anchor.upsert', 'narrative.set', 'decision-style.set', 'cognitive-model.set', 'personaRule.insert']) {
      assert.throws(() => ob.enqueue('fact', op, {}, 1000), /防身份核误标/, `${op} 应被识别为 identity`);
    }
    /* 蒸馏 artifact kind 也覆盖。 */
    assert.throws(() => ob.enqueue('fact', 'value_shift', {}, 1000), /防身份核误标/);
  });

  it('fromSerialized 完整校验：坏落盘数据（身份 op 标 fact）被拒，不绕过护栏', () => {
    const bad = JSON.stringify({
      deviceId: 'A', nextSeq: 2,
      entries: [{ deviceId: 'A', seq: 1, changeClass: 'fact', opKind: 'core-value.update', payload: {}, at: 1, synced: false }],
    });
    assert.throws(() => SyncOutbox.fromSerialized(bad), /推导.*不一致/);
  });

  it('fromSerialized：nextSeq 必须大于 max(seq)', () => {
    const bad = JSON.stringify({
      deviceId: 'A', nextSeq: 1,
      entries: [{ deviceId: 'A', seq: 1, changeClass: 'fact', opKind: 'memory.append', payload: {}, at: 1, synced: false }],
    });
    assert.throws(() => SyncOutbox.fromSerialized(bad), /nextSeq/);
  });

  it('深拷贝：嵌套 payload 不外泄 live reference（all + enqueue 入参/返回值）', () => {
    const ob = new SyncOutbox('A');
    const src = { nested: { v: 1 } };
    const returned = ob.enqueue('fact', 'memory.append', src, 1000);
    /* 篡改 enqueue 入参源对象 → 不应影响内部。 */
    src.nested.v = 777;
    /* 篡改 enqueue 返回值 → 不应影响内部。 */
    (returned.payload.nested as { v: number }).v = 888;
    /* 篡改 all() 读出 → 不应影响内部。 */
    (ob.all()[0].payload.nested as { v: number }).v = 999;
    assert.equal((ob.all()[0].payload.nested as { v: number }).v, 1, '内部状态隔离所有外部篡改');
  });

  it('pending/all 返回拷贝（不可绕过 markSynced 改 synced）', () => {
    const ob = new SyncOutbox('device-A');
    ob.enqueue('fact', 'memory.append', { id: 'm1' }, 1000);
    const p = ob.pending();
    (p[0] as { synced: boolean }).synced = true;   /* 篡改拷贝 */
    assert.equal(ob.pending().length, 1, '内部状态不受拷贝篡改影响');
  });
});

describe('多设备冲突解决三分法（ADR-0052 Edge-P3）', () => {
  function ref(deviceId: string, seq: number, changeClass: ChangeRef['changeClass'], targetId: string): ChangeRef {
    return { deviceId, seq, changeClass, opKind: 'op', targetId };
  }

  it('fact：append-only 合并 + (deviceId,seq) 去重', () => {
    const r = resolveConflict([
      ref('A', 1, 'fact', 'm1'),
      ref('B', 1, 'fact', 'm1'),
      ref('A', 1, 'fact', 'm1'),   /* A:1 重复（重传）→ 去重 */
    ]);
    assert.equal(r.action, 'merge');
    if (r.action === 'merge') {
      assert.equal(r.entries.length, 2, 'A:1 与 B:1 保留，重复 A:1 去重');
    }
  });

  it('projection：可合并读模型 → 重建（不作冲突源）', () => {
    const r = resolveConflict([
      ref('A', 5, 'projection', 'p1'),
      ref('B', 7, 'projection', 'p1'),
    ]);
    assert.equal(r.action, 'rebuild');
  });

  it('身份核（identity）：多设备并发冲突 → pending，绝不 last-write-wins', () => {
    const r = resolveConflict([
      ref('A', 3, 'identity', 'value-explore'),
      ref('B', 4, 'identity', 'value-explore'),
    ]);
    assert.equal(r.action, 'pending', '身份核冲突必须 pending，不自动合并/覆盖');
    if (r.action === 'pending') assert.equal(r.conflict.length, 2);
  });

  it('身份核：单一变更也走 pending（绝不自动应用）', () => {
    const r = resolveConflict([ref('A', 3, 'identity', 'value-explore')]);
    assert.equal(r.action, 'pending');
  });

  it('同目标混合含 identity → 整组保守按 pending（最高风险优先）', () => {
    /* 同一 targetId 上既有 fact 又有 identity 变更（如对同一实体的事实记录 + 身份核改动）。 */
    const r = resolveConflict([
      ref('A', 1, 'fact', 'value-x'),
      ref('B', 2, 'identity', 'value-x'),
    ]);
    assert.equal(r.action, 'pending', '任一身份核变更 → 整组 pending');
  });

  it('toChangeRef 从 outbox entry 投影 targetId', () => {
    const ob = new SyncOutbox('A');
    const e = ob.enqueue('fact', 'memory.append', { id: 'm1' }, 1000);
    assert.equal(toChangeRef(e).targetId, 'm1');
  });

  it('确定性：同输入 → 同 resolution', () => {
    const input = [ref('A', 1, 'fact', 'm1'), ref('B', 1, 'fact', 'm1')];
    assert.deepEqual(resolveConflict(input), resolveConflict(input));
  });

  it('单目标契约：resolveConflict 收到跨 targetId 抛错', () => {
    assert.throws(
      () => resolveConflict([ref('A', 1, 'fact', 'm1'), ref('B', 1, 'fact', 'm2')]),
      /单一 targetId/,
    );
  });

  it('resolveConflictsByTarget：自动按 targetId 分组逐组解决', () => {
    const byTarget = resolveConflictsByTarget([
      ref('A', 1, 'fact', 'm1'),
      ref('B', 1, 'fact', 'm1'),
      ref('A', 2, 'identity', 'value-x'),
    ]);
    assert.equal(byTarget.get('m1')!.action, 'merge');
    assert.equal(byTarget.get('value-x')!.action, 'pending');
  });

  it('toChangeRef 无 targetId → 用 deviceId:seq 占位（不误合并）', () => {
    const ob = new SyncOutbox('A');
    const e = ob.enqueue('fact', 'memory.append', { note: 'no-id-field' }, 1000);
    assert.equal(toChangeRef(e).targetId, 'A:1', '无 id/targetId → 唯一占位');
  });
});
