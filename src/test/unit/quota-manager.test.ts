import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import type { IDatabase } from '../../storage/database.js';

describe('QuotaManager', () => {
  let db: IDatabase;
  let qm: QuotaManager;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    qm = new QuotaManager(db);
  });

  it('无限制时 checkQuota 返回 true', () => {
    assert.equal(qm.checkQuota('tenant-a', 'decisions'), true);
  });

  it('设置限制后 checkQuota 正常检查', () => {
    qm.setLimit('tenant-a', 'decisions', 3, 60_000);

    const now = 100_000;
    qm.recordUsage('tenant-a', 'decisions', now);
    qm.recordUsage('tenant-a', 'decisions', now);

    /* 使用 2 次，限额 3 → 还有配额 */
    assert.equal(qm.checkQuota('tenant-a', 'decisions', now), true);

    qm.recordUsage('tenant-a', 'decisions', now);

    /* 使用 3 次 = 限额 → 无配额 */
    assert.equal(qm.checkQuota('tenant-a', 'decisions', now), false);
  });

  it('不同租户配额独立', () => {
    qm.setLimit('tenant-a', 'decisions', 1, 60_000);
    qm.setLimit('tenant-b', 'decisions', 1, 60_000);

    const now = 100_000;
    qm.recordUsage('tenant-a', 'decisions', now);

    assert.equal(qm.checkQuota('tenant-a', 'decisions', now), false);
    assert.equal(qm.checkQuota('tenant-b', 'decisions', now), true);
  });

  it('更新限制使用 upsert', () => {
    qm.setLimit('tenant-a', 'decisions', 1, 60_000);
    qm.setLimit('tenant-a', 'decisions', 10, 60_000);

    const now = 100_000;
    qm.recordUsage('tenant-a', 'decisions', now);

    /* 更新后限额变为 10，仅用了 1 → 有配额 */
    assert.equal(qm.checkQuota('tenant-a', 'decisions', now), true);
  });
});
