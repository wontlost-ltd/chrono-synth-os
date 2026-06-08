import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import {
  putEntity,
  getEntity,
  getEntitiesByTenant,
  listProjection,
  deleteEntity,
  enqueueOutbox,
  dequeueOutbox,
  countOutbox,
  getOutboxByTenant,
  incrementOutboxAttempts,
  getSyncMeta,
  setSyncMeta,
  clearReplicaStore,
  _resetDbForTest,
} from './replica-store';

beforeEach(() => {
  // Provide a fresh IndexedDB instance for each test to avoid state leakage
  _resetDbForTest();
  const g = globalThis as unknown as { indexedDB: IDBFactory; IDBKeyRange: typeof FakeIDBKeyRange };
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = FakeIDBKeyRange;
});

describe('replica-store: entities', () => {
  it('put and get round-trips entity', async () => {
    const entity = {
      entityRef: 'persona/abc',
      tenantId: 'tenant-1',
      projection: 'persona',
      data: { name: 'Alice' },
      serverVersion: 1,
      syncedAt: 1000,
    };
    await putEntity(entity);
    const result = await getEntity('persona/abc');
    expect(result).toEqual(entity);
  });

  it('returns undefined for missing entity', async () => {
    const result = await getEntity('persona/missing');
    expect(result).toBeUndefined();
  });

  it('getEntitiesByTenant filters by tenantId', async () => {
    await putEntity({ entityRef: 'persona/a', tenantId: 'tenant-1', data: {}, serverVersion: 1, syncedAt: 1 });
    await putEntity({ entityRef: 'persona/b', tenantId: 'tenant-2', data: {}, serverVersion: 1, syncedAt: 1 });
    const results = await getEntitiesByTenant('tenant-1');
    expect(results).toHaveLength(1);
    expect(results[0]?.entityRef).toBe('persona/a');
  });

  it('listProjection filters by tenant and projection', async () => {
    await putEntity({
      entityRef: 'tenant-1:people:person-1',
      tenantId: 'tenant-1',
      data: { name: 'Ada' },
      serverVersion: 1,
      syncedAt: 1,
    });
    await putEntity({
      entityRef: 'tenant-1:projects:project-1',
      tenantId: 'tenant-1',
      data: { name: 'Compiler' },
      serverVersion: 1,
      syncedAt: 1,
    });
    await putEntity({
      entityRef: 'tenant-2:people:person-1',
      tenantId: 'tenant-2',
      data: { name: 'Grace' },
      serverVersion: 1,
      syncedAt: 1,
    });

    const results = await listProjection<{ name: string }>('tenant-1', 'people');
    expect(results).toHaveLength(1);
    expect(results[0]?.entityRef).toBe('tenant-1:people:person-1');
    expect(results[0]?.data.name).toBe('Ada');
  });

  it('deleteEntity removes the entry', async () => {
    await putEntity({ entityRef: 'persona/x', tenantId: 't1', data: {}, serverVersion: 1, syncedAt: 1 });
    await deleteEntity('persona/x');
    expect(await getEntity('persona/x')).toBeUndefined();
  });

  it('put overwrites existing entity', async () => {
    await putEntity({ entityRef: 'persona/abc', tenantId: 't1', data: { v: 1 }, serverVersion: 1, syncedAt: 1 });
    await putEntity({ entityRef: 'persona/abc', tenantId: 't1', data: { v: 2 }, serverVersion: 2, syncedAt: 2 });
    const result = await getEntity('persona/abc');
    expect((result?.data as { v: number }).v).toBe(2);
    expect(result?.serverVersion).toBe(2);
  });
});

describe('replica-store: outbox', () => {
  const makeEntry = (commandId: string, tenantId = 'tenant-1') => ({
    commandId,
    tenantId,
    entityRef: 'persona/abc',
    envelope: { commandId },
    enqueuedAt: Date.now(),
    attempts: 0,
  });

  it('enqueue and getOutboxByTenant round-trips', async () => {
    await enqueueOutbox(makeEntry('cmd-1'));
    const results = await getOutboxByTenant('tenant-1');
    expect(results).toHaveLength(1);
    expect(results[0]?.commandId).toBe('cmd-1');
  });

  it('dequeue removes entry', async () => {
    await enqueueOutbox(makeEntry('cmd-2'));
    await dequeueOutbox('cmd-2');
    expect(await countOutbox('tenant-1')).toBe(0);
  });

  it('countOutbox counts by tenant', async () => {
    await enqueueOutbox(makeEntry('cmd-3', 'tenant-1'));
    await enqueueOutbox(makeEntry('cmd-4', 'tenant-2'));
    expect(await countOutbox('tenant-1')).toBe(1);
    expect(await countOutbox('tenant-2')).toBe(1);
  });

  it('incrementOutboxAttempts increments attempt counter', async () => {
    await enqueueOutbox(makeEntry('cmd-5'));
    await incrementOutboxAttempts('cmd-5');
    await incrementOutboxAttempts('cmd-5');
    const results = await getOutboxByTenant('tenant-1');
    expect(results[0]?.attempts).toBe(2);
  });

  it('incrementOutboxAttempts on missing entry is a no-op', async () => {
    await expect(incrementOutboxAttempts('nonexistent')).resolves.toBeUndefined();
  });
});

describe('replica-store: sync_meta', () => {
  it('setSyncMeta and getSyncMeta round-trips', async () => {
    await setSyncMeta('pull_cursor:tenant-1', 'cursor-abc');
    const result = await getSyncMeta<string>('pull_cursor:tenant-1');
    expect(result).toBe('cursor-abc');
  });

  it('returns undefined for missing key', async () => {
    const result = await getSyncMeta('nonexistent');
    expect(result).toBeUndefined();
  });

  it('setSyncMeta overwrites existing value', async () => {
    await setSyncMeta('key', 'v1');
    await setSyncMeta('key', 'v2');
    expect(await getSyncMeta('key')).toBe('v2');
  });
});

describe('replica-store: clearReplicaStore', () => {
  it('clears all stores', async () => {
    await putEntity({ entityRef: 'persona/z', tenantId: 't1', data: {}, serverVersion: 1, syncedAt: 1 });
    await enqueueOutbox({ commandId: 'x', tenantId: 't1', entityRef: 'persona/z', envelope: {}, enqueuedAt: 1, attempts: 0 });
    await setSyncMeta('k', 'v');
    await clearReplicaStore();
    expect(await getEntity('persona/z')).toBeUndefined();
    expect(await countOutbox('t1')).toBe(0);
    expect(await getSyncMeta('k')).toBeUndefined();
  });
});
