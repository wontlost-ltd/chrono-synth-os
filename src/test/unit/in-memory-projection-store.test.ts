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
