import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryProjectionStore } from '../../data-plane/in-memory-projection-store.js';

describe('InMemoryProjectionStore', () => {
  let store: InMemoryProjectionStore;

  beforeEach(() => {
    store = new InMemoryProjectionStore();
  });

  it('read() returns null for missing entry', async () => {
    const result = await store.read('t1', 'proj', 'missing');
    assert.equal(result, null);
  });

  it('write() then read() round-trip', async () => {
    await store.write('t1', 'proj', 'id-1', { name: 'Alice' }, 1);
    const result = await store.read<{ name: string }>('t1', 'proj', 'id-1');
    assert.deepEqual(result, { name: 'Alice' });
  });

  it('list() returns items sorted by id asc', async () => {
    await store.write('t1', 'proj', 'c', {}, 1);
    await store.write('t1', 'proj', 'a', {}, 1);
    await store.write('t1', 'proj', 'b', {}, 1);
    const { items } = await store.list('t1', 'proj');
    assert.equal(items.length, 3);
  });

  it('list() returns items in ascending id order', async () => {
    await store.write('t1', 'proj', 'c', { id: 'c' }, 1);
    await store.write('t1', 'proj', 'a', { id: 'a' }, 1);
    await store.write('t1', 'proj', 'b', { id: 'b' }, 1);

    const { items } = await store.list<{ id: string }>('t1', 'proj', { direction: 'asc' });

    assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c']);
  });

  it('tenant and projection scopes do not bleed', async () => {
    await store.write('t1', 'proj', 'id-1', { v: 1 }, 1);
    await store.write('t2', 'proj', 'id-1', { v: 2 }, 1);

    assert.deepEqual(await store.read('t1', 'proj', 'id-1'), { v: 1 });
    const { items } = await store.list('t1', 'proj');
    assert.equal(items.length, 1);
  });

  it('write() overwrites previous value', async () => {
    await store.write('t1', 'p', 'x', { n: 1 }, 1);
    await store.write('t1', 'p', 'x', { n: 2 }, 2);

    assert.deepEqual(await store.read('t1', 'p', 'x'), { n: 2 });
  });

  it('list() with cursor skips correctly', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.write('t1', 'proj', `id-${i}`, { n: i }, 1);
    }
    const { items } = await store.list('t1', 'proj', { cursor: 'id-3' });
    assert.equal(items.length, 2);
  });

  it('list() direction=desc reverses order', async () => {
    await store.write('t1', 'proj', 'a', { v: 1 }, 1);
    await store.write('t1', 'proj', 'b', { v: 2 }, 1);
    const { items } = await store.list<{ v: number }>('t1', 'proj', { direction: 'desc' });
    assert.equal(items[0]!.v, 2);
    assert.equal(items[1]!.v, 1);
  });

  it('list() nextCursor is null when no more items', async () => {
    await store.write('t1', 'proj', 'only', {}, 1);
    const { nextCursor } = await store.list('t1', 'proj', { limit: 10 });
    assert.equal(nextCursor, null);
  });

  it('list() nextCursor set when more items exist', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.write('t1', 'proj', `id-${i}`, {}, 1);
    }
    const { nextCursor } = await store.list('t1', 'proj', { limit: 3 });
    assert.ok(nextCursor !== null);
  });

  it('clear() empties the store', async () => {
    await store.write('t1', 'proj', 'x', {}, 1);
    store.clear();
    const result = await store.read('t1', 'proj', 'x');
    assert.equal(result, null);
  });
});

/* 与 SqliteProjectionStore 同一语义（审计 Warning B5-6）：内存实现若放行
 * SQLite 实际拒绝的乱序写入，测试就会掩盖生产行为差异。 */
describe('InMemoryProjectionStore — 版本单调', () => {
  let s: InMemoryProjectionStore;
  beforeEach(() => { s = new InMemoryProjectionStore(); });

  it('较低版本不得覆盖', async () => {
    await s.write('t1', 'proj', 'id-1', { v: 'v2' }, 2);
    await s.write('t1', 'proj', 'id-1', { v: 'v1-late' }, 1);
    assert.deepEqual(await s.read('t1', 'proj', 'id-1'), { v: 'v2' });
  });

  it('同版本重放不改变状态', async () => {
    await s.write('t1', 'proj', 'id-1', { v: 'original' }, 2);
    await s.write('t1', 'proj', 'id-1', { v: 'replayed' }, 2);
    assert.deepEqual(await s.read('t1', 'proj', 'id-1'), { v: 'original' });
  });

  it('更高版本正常覆盖', async () => {
    await s.write('t1', 'proj', 'id-1', { v: 'v1' }, 1);
    await s.write('t1', 'proj', 'id-1', { v: 'v2' }, 2);
    assert.deepEqual(await s.read('t1', 'proj', 'id-1'), { v: 'v2' });
  });
});
