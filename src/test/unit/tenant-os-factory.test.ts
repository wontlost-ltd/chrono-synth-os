import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { IDatabase } from '../../storage/database.js';

describe('TenantOSFactory', () => {
  let db: IDatabase;
  let factory: TenantOSFactory;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    factory = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), { maxCachedTenants: 3 });
  });

  it('创建并缓存租户 OS 实例', () => {
    const os1 = factory.getTenantOS('tenant-a');
    const os2 = factory.getTenantOS('tenant-a');
    assert.strictEqual(os1, os2, '同一租户返回缓存实例');
    assert.equal(factory.cachedCount, 1);
  });

  it('不同租户获得不同实例', () => {
    const osA = factory.getTenantOS('tenant-a');
    const osB = factory.getTenantOS('tenant-b');
    assert.notStrictEqual(osA, osB);
    assert.equal(factory.cachedCount, 2);
  });

  it('超过容量限制时 LRU 驱逐', () => {
    factory.getTenantOS('t1');
    factory.getTenantOS('t2');
    factory.getTenantOS('t3');
    assert.equal(factory.cachedCount, 3);

    /* 添加第 4 个，应驱逐最早访问的 */
    factory.getTenantOS('t4');
    assert.equal(factory.cachedCount, 3);
  });

  it('clear 清理所有缓存', () => {
    factory.getTenantOS('t1');
    factory.getTenantOS('t2');
    factory.clear();
    assert.equal(factory.cachedCount, 0);
  });

  it('evict 驱逐指定租户', () => {
    factory.getTenantOS('t1');
    factory.getTenantOS('t2');
    assert.equal(factory.cachedCount, 2);

    factory.evict('t1');
    assert.equal(factory.cachedCount, 1);

    /* 再次获取应创建新实例 */
    const os1 = factory.getTenantOS('t1');
    assert.equal(factory.cachedCount, 2);
    assert.ok(os1);
  });

  it('evict 不存在的租户无影响', () => {
    factory.getTenantOS('t1');
    factory.evict('nonexistent');
    assert.equal(factory.cachedCount, 1);
  });
});
