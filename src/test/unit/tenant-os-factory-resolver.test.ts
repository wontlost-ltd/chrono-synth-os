import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { realClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';

describe('TenantOSFactory 用 TenantDbResolver（零回归）', () => {
  it('注 SingleDbResolver：getTenantOS 正常建租户 OS（单库等价现状）', () => {
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);
    const factory = new TenantOSFactory(new SingleDbResolver(db), realClock, new SilentLogger());
    const os = factory.getTenantOS('t1');
    assert.ok(os, '租户 OS 建出');
    assert.equal(os.getTenantId(), 't1');
    factory.clear();
  });
});
