import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolver, MultiShardRuntimeNotReadyError } from '../../storage/build-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { SqliteDatabase } from '../../storage/database.js';

function cfg(shards?: unknown) {
  return { db: { driver: 'sqlite', path: ':memory:', shards, pool: { max: 10, idleTimeoutMs: 30000 } } } as never;
}

test('单库（shards 空）→ SingleDbResolver，三方法同一 db（零回归）', () => {
  const db = new SqliteDatabase(':memory:');
  const r = buildResolver(cfg(undefined), db);
  assert.ok(r instanceof SingleDbResolver);
  assert.equal(r.dbForTenant('t1'), db);
  assert.equal(r.coordinatorDb(), db);
  assert.deepEqual(r.allShardDbs(), [db]);
  db.close();
});

test('多库（shards 非空）→ buildResolver throw MultiShardRuntimeNotReadyError（Plan 1 不构造多库 runtime）', () => {
  const hostDb = new SqliteDatabase(':memory:');
  assert.throws(
    () => buildResolver(cfg({ s0: { connectionString: 'postgres://h' } }), hostDb),
    MultiShardRuntimeNotReadyError,
  );
  hostDb.close();
});
