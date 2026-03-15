import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import {
  LegacySyncBridge,
  WriteCommittedPublishError,
  clearRegistries,
  registerCommand,
  registerQuery,
} from '../../storage/legacy-sync-bridge.js';
import type { DomainEvent, EventPublisher } from '@chrono/kernel';

function createTestPublisher(): EventPublisher & { published: readonly DomainEvent[][] } {
  const published: DomainEvent[][] = [];
  return {
    published,
    async publish(events: readonly DomainEvent[]) {
      published.push([...events]);
    },
  };
}

function createFailingPublisher(): EventPublisher {
  return {
    async publish() {
      throw new Error('publish failed');
    },
  };
}

describe('LegacySyncBridge', () => {
  beforeEach(() => {
    clearRegistries();
  });

  describe('registerQuery / registerCommand', () => {
    it('rejects duplicate query registration', () => {
      registerQuery('test.query', () => null);
      assert.throws(
        () => registerQuery('test.query', () => null),
        /已注册/,
      );
    });

    it('rejects duplicate command registration', () => {
      registerCommand('test.cmd', () => ({ rowsAffected: 0 }));
      assert.throws(
        () => registerCommand('test.cmd', () => ({ rowsAffected: 0 })),
        /已注册/,
      );
    });

    it('allows registration after clearRegistries', () => {
      registerQuery('test.query', () => null);
      clearRegistries();
      assert.doesNotThrow(() => registerQuery('test.query', () => null));
    });
  });

  describe('read()', () => {
    it('executes a synchronous read callback', async () => {
      registerQuery('probe', (_db, params) => ({ id: params }));
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);

      const result = await bridge.read({ tenantId: 't1' }, (tx) => {
        return tx.queryOne({ kind: 'probe', params: 'abc' });
      });

      assert.deepEqual(result, { id: 'abc' });
    });

    it('rejects async callbacks at runtime', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);
      const asyncFn = async () => 1;

      await assert.rejects(
        () => bridge.read({ tenantId: 't1' }, asyncFn as unknown as () => number),
        /Promise/,
      );
    });

    it('closes UoW after callback returns', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);
      registerQuery('probe', () => 42);

      let capturedTx: ReturnType<Parameters<typeof bridge.read>[1]> extends infer R ? R : never;
      await bridge.read({ tenantId: 't1' }, (tx) => {
        capturedTx = tx as typeof capturedTx;
        return tx.queryOne({ kind: 'probe', params: null });
      });

      assert.throws(
        () => (capturedTx as { queryOne: (q: unknown) => unknown }).queryOne({ kind: 'probe', params: null }),
        /已关闭/,
      );
    });
  });

  describe('write()', () => {
    it('executes a synchronous write with events', async () => {
      registerCommand('insert', () => ({ rowsAffected: 1 }));
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);

      const event: DomainEvent = {
        type: 'test.created',
        tenantId: 't1',
        occurredAt: Date.now(),
        payload: { id: '1' },
      };

      const result = await bridge.write({ tenantId: 't1' }, (tx) => {
        const execResult = tx.execute({ kind: 'insert', params: null });
        tx.afterCommit(event);
        return execResult;
      });

      assert.equal(result.rowsAffected, 1);
      assert.equal(publisher.published.length, 1);
      assert.deepEqual(publisher.published[0], [event]);
    });

    it('rejects async callbacks at runtime', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);
      const asyncFn = async () => 1;

      await assert.rejects(
        () => bridge.write({ tenantId: 't1' }, asyncFn as unknown as () => number),
        /Promise/,
      );
    });

    it('throws WriteCommittedPublishError when publish fails', async () => {
      registerCommand('insert', () => ({ rowsAffected: 1 }));
      const db = createMemoryDatabase();
      const bridge = new LegacySyncBridge(db, createFailingPublisher());

      try {
        await bridge.write({ tenantId: 't1' }, (tx) => {
          tx.afterCommit({
            type: 'evt',
            tenantId: 't1',
            occurredAt: 1,
            payload: {},
          });
          return tx.execute({ kind: 'insert', params: null });
        });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err instanceof WriteCommittedPublishError);
        assert.equal(err.committed, true);
        assert.ok(err.cause instanceof Error);
      }
    });

    it('prevents deferred afterCommit via UoW close', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);
      registerQuery('probe', () => 42);

      let deferredError: unknown;
      await bridge.write({ tenantId: 't1' }, (tx) => {
        queueMicrotask(() => {
          try {
            tx.afterCommit({
              type: 'deferred',
              tenantId: 't1',
              occurredAt: 1,
              payload: {},
            });
          } catch (error) {
            deferredError = error;
          }
        });
        return tx.queryOne({ kind: 'probe', params: null });
      });

      // microtask 在 await 后执行
      await new Promise<void>((resolve) => { queueMicrotask(() => { resolve(); }); });

      assert.ok(deferredError instanceof Error);
      assert.match((deferredError as Error).message, /已关闭/);
      assert.equal(publisher.published.length, 1);
      assert.deepEqual(publisher.published[0], []);
    });
  });

  describe('error handling', () => {
    it('throws on unregistered query', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);

      await assert.rejects(
        () => bridge.read({ tenantId: 't1' }, (tx) => tx.queryOne({ kind: 'nonexistent', params: null })),
        /未注册的查询/,
      );
    });

    it('throws on unregistered command', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const bridge = new LegacySyncBridge(db, publisher);

      await assert.rejects(
        () => bridge.write({ tenantId: 't1' }, (tx) => tx.execute({ kind: 'nonexistent', params: null })),
        /未注册的命令/,
      );
    });
  });
});
