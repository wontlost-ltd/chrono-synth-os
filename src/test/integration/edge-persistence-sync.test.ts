/**
 * 端侧持久化 + 同步边界（ADR-0052 Edge-P3）：端侧人格状态可落盘+重载+replay 一致；本地变更入
 * outbox；多设备冲突按三分法解决——**身份核冲突绝不 last-write-wins**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryValueUnitOfWork, DeterministicClock, DeterministicRandom,
  InMemoryPersistence, SyncOutbox, resolveConflict, toChangeRef,
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

  it('混合含 identity → 整组保守按 pending（最高风险优先）', () => {
    const r = resolveConflict([
      ref('A', 1, 'fact', 'm1'),
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
});
