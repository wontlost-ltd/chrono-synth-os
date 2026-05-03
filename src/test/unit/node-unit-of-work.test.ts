import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import {
  clearRegistries,
  registerCommand,
  registerQuery,
} from '../../storage/legacy-sync-bridge.js';
import { NodeUnitOfWorkFactory } from '../../storage/node-unit-of-work.js';
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

describe('NodeUnitOfWorkFactory', () => {
  beforeEach(() => {
    clearRegistries();
  });

  describe('read()', () => {
    it('executes read callback and returns result', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const factory = new NodeUnitOfWorkFactory(db, publisher);

      registerQuery<number, void>('count.query', () => 42);

      const result = await factory.read({ tenantId: 'tenant-1' }, async (tx) => {
        return tx.queryOne<number, void>({ kind: 'count.query', params: undefined });
      });

      assert.equal(result, 42);
    });

    it('throws on unregistered query', async () => {
      const db = createMemoryDatabase();
      const factory = new NodeUnitOfWorkFactory(db, createTestPublisher());

      await assert.rejects(
        () => factory.read({ tenantId: 'tenant-1' }, (tx) =>
          tx.queryOne({ kind: 'unknown.query', params: undefined }),
        ),
        /未注册的查询/,
      );
    });

    it('closes uow after callback (prevents post-close access)', async () => {
      const db = createMemoryDatabase();
      const factory = new NodeUnitOfWorkFactory(db, createTestPublisher());
      registerQuery('noop.query', () => null);

      let capturedTx: Parameters<Parameters<typeof factory.read>[1]>[0] | undefined;
      await factory.read({ tenantId: 'tenant-1' }, async (tx) => {
        capturedTx = tx;
        return null;
      });

      await assert.rejects(
        () => capturedTx!.queryOne({ kind: 'noop.query', params: undefined }),
        /工作单元已关闭/,
      );
    });
  });

  describe('write()', () => {
    it('executes command and publishes afterCommit events', async () => {
      const db = createMemoryDatabase();
      db.exec('CREATE TABLE IF NOT EXISTS t (v INTEGER)');

      const publisher = createTestPublisher();
      const factory = new NodeUnitOfWorkFactory(db, publisher);

      registerCommand<{ v: number }>('insert.cmd', (d, params) => {
        d.prepare('INSERT INTO t VALUES (?)').run(params.v);
        return { rowsAffected: 1 };
      });

      const event: DomainEvent = { type: 'test.event', payload: { x: 1 }, occurredAt: Date.now(), tenantId: 'tenant-1' };

      await factory.write({ tenantId: 'tenant-1' }, async (tx) => {
        await tx.execute({ kind: 'insert.cmd', params: { v: 99 } });
        tx.afterCommit(event);
      });

      const rows = db.prepare<{ v: number }>('SELECT v FROM t').all();
      assert.equal(rows[0]?.v, 99);
      assert.equal(publisher.published.length, 1);
      assert.deepEqual(publisher.published[0]![0], event);
    });

    it('rolls back on command error', async () => {
      const db = createMemoryDatabase();
      db.exec('CREATE TABLE IF NOT EXISTS t2 (v INTEGER NOT NULL)');
      const factory = new NodeUnitOfWorkFactory(db, createTestPublisher());

      registerCommand<void>('bad.cmd', () => {
        throw new Error('command failed');
      });

      await assert.rejects(
        () => factory.write({ tenantId: 'tenant-1' }, async (tx) => {
          await tx.execute({ kind: 'bad.cmd', params: undefined });
        }),
        /command failed/,
      );

      const rows = db.prepare<{ v: number }>('SELECT v FROM t2').all();
      assert.equal(rows.length, 0);
    });

    it('does not publish events when transaction throws', async () => {
      const db = createMemoryDatabase();
      const publisher = createTestPublisher();
      const factory = new NodeUnitOfWorkFactory(db, publisher);

      registerCommand<void>('throw.cmd', () => { throw new Error('tx error'); });

      await assert.rejects(
        () => factory.write({ tenantId: 'tenant-1' }, async (tx) => {
          tx.afterCommit({ type: 'should.not.publish', payload: {}, occurredAt: 1, tenantId: 'tenant-1' });
          await tx.execute({ kind: 'throw.cmd', params: undefined });
        }),
      );

      assert.equal(publisher.published.length, 0);
    });

    it('supports truly async operations inside write callback', async () => {
      const db = createMemoryDatabase();
      db.exec('CREATE TABLE IF NOT EXISTS t3 (v INTEGER)');
      const factory = new NodeUnitOfWorkFactory(db, createTestPublisher());

      registerCommand<{ v: number }>('async.cmd', (d, params) => {
        d.prepare('INSERT INTO t3 VALUES (?)').run(params.v);
        return { rowsAffected: 1 };
      });

      await factory.write({ tenantId: 'tenant-1' }, async (tx) => {
        await Promise.resolve();
        await tx.execute({ kind: 'async.cmd', params: { v: 7 } });
      });

      const rows = db.prepare<{ v: number }>('SELECT v FROM t3').all();
      assert.equal(rows[0]?.v, 7);
    });
  });
});
