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

  it('consumeQuota 无限制时始终成功并记录用量', () => {
    const now = 100_000;
    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), true);
  });

  it('consumeQuota 达到限额后拒绝', () => {
    qm.setLimit('tenant-a', 'sim', 2, 60_000);
    const now = 100_000;

    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), true);
    /* 第 3 次应被拒绝 */
    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), false);
  });

  it('consumeQuota 限额为 0 时直接拒绝', () => {
    qm.setLimit('tenant-a', 'sim', 0, 60_000);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 100_000), false);
  });

  it('clearLimit 后恢复无限制', () => {
    qm.setLimit('tenant-a', 'sim', 1, 60_000);
    const now = 100_000;
    qm.consumeQuota('tenant-a', 'sim', now);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), false);

    qm.clearLimit('tenant-a', 'sim');
    assert.equal(qm.consumeQuota('tenant-a', 'sim', now), true);
  });
});
