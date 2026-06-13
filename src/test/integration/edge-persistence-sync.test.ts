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
    assert.throws(() => tx.restore('{"not":"array"}'), /必须是数组/);
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

  it('防误标护栏：身份核 op 标成 fact → enqueue 抛错', () => {
    const ob = new SyncOutbox('device-A');
    /* value.update 推导为 identity，标成 fact → 拦截。 */
    assert.throws(() => ob.enqueue('fact', 'value.update', { id: 'v1' }, 1000), /防身份核误标/);
    /* 正确标 identity → 通过。 */
    const e = ob.enqueue('identity', 'value.update', { id: 'v1' }, 1000);
    assert.equal(e.changeClass, 'identity');
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
