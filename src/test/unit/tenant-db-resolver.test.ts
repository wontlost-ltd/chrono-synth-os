import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase } from '../../storage/index.js';

describe('TenantDbResolver（分片地基 Phase -1）', () => {
  it('SingleDbResolver：三方法都返回同一个 db（单库等价现状）', () => {
    const db = createMemoryDatabase();
    const r = new SingleDbResolver(db);
    assert.strictEqual(r.dbForTenant('t1'), db);
    assert.strictEqual(r.dbForTenant('t2'), db, '不同租户单库下也是同一 db');
    assert.strictEqual(r.dbForTenant('default'), db);
    assert.strictEqual(r.coordinatorDb(), db);
    assert.strictEqual(r.allShardDbs().length, 1, 'allShardDbs 单库下就一个');
    assert.strictEqual(r.allShardDbs()[0], db, 'allShardDbs[0] 是同一个 db 实例');
  });

  it('dbForTenant 对任意 tenantId 都不抛（单库恒同 db）', () => {
    const db = createMemoryDatabase();
    const r = new SingleDbResolver(db);
    for (const t of ['', 'default', 'tenant_abc', 'x'.repeat(200)]) {
      assert.strictEqual(r.dbForTenant(t), db);
    }
  });
});
