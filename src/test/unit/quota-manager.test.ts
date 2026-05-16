import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import type { IDatabase } from '../../storage/database.js';

describe('QuotaManager', () => {
  let db: IDatabase;
  let qm: QuotaManager;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    qm = new QuotaManager(db);
  });

  it('无限制时 checkQuota 返回 true', () => {
    assert.equal(qm.checkQuota('tenant-a', 'decisions'), true);
  });

  it('设置限制后 checkQuota 正常检查', () => {
    qm.setLimit('tenant-a', 'decisions', 3, 60_000);

    const now = 100_000;
    qm.recordUsage('tenant-a', 'decisions', 1, now);
    qm.recordUsage('tenant-a', 'decisions', 1, now);

    /* 使用 2 次，限额 3 → 还有配额 */
    assert.equal(qm.checkQuota('tenant-a', 'decisions', 1, now), true);

    qm.recordUsage('tenant-a', 'decisions', 1, now);

    /* 使用 3 次 = 限额 → 无配额 */
    assert.equal(qm.checkQuota('tenant-a', 'decisions', 1, now), false);
  });

  it('不同租户配额独立', () => {
    qm.setLimit('tenant-a', 'decisions', 1, 60_000);
    qm.setLimit('tenant-b', 'decisions', 1, 60_000);

    const now = 100_000;
    qm.recordUsage('tenant-a', 'decisions', 1, now);

    assert.equal(qm.checkQuota('tenant-a', 'decisions', 1, now), false);
    assert.equal(qm.checkQuota('tenant-b', 'decisions', 1, now), true);
  });

  it('更新限制使用 upsert', () => {
    qm.setLimit('tenant-a', 'decisions', 1, 60_000);
    qm.setLimit('tenant-a', 'decisions', 10, 60_000);

    const now = 100_000;
    qm.recordUsage('tenant-a', 'decisions', 1, now);

    /* 更新后限额变为 10，仅用了 1 → 有配额 */
    assert.equal(qm.checkQuota('tenant-a', 'decisions', 1, now), true);
  });

  it('consumeQuota 无限制时始终成功并记录用量', () => {
    const now = 100_000;
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), true);
  });

  it('consumeQuota 达到限额后拒绝', () => {
    qm.setLimit('tenant-a', 'sim', 2, 60_000);
    const now = 100_000;

    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), true);
    /* 第 3 次应被拒绝 */
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), false);
  });

  it('consumeQuota 限额为 0 时直接拒绝', () => {
    qm.setLimit('tenant-a', 'sim', 0, 60_000);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, 100_000), false);
  });

  it('clearLimit 后恢复无限制', () => {
    qm.setLimit('tenant-a', 'sim', 1, 60_000);
    const now = 100_000;
    qm.consumeQuota('tenant-a', 'sim', 1, now);
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), false);

    qm.clearLimit('tenant-a', 'sim');
    assert.equal(qm.consumeQuota('tenant-a', 'sim', 1, now), true);
  });

  describe('数量感知配额（LLM token 用量场景）', () => {
    it('checkQuota 按数量检查剩余额度', () => {
      qm.setLimit('tenant-a', 'llm_tokens', 10_000, 3_600_000);
      const now = 100_000;

      qm.recordUsage('tenant-a', 'llm_tokens', 8_000, now);

      /* 8000 已用 + 1500 请求 = 9500 <= 10000 → 允许 */
      assert.equal(qm.checkQuota('tenant-a', 'llm_tokens', 1_500, now), true);

      /* 8000 已用 + 3000 请求 = 11000 > 10000 → 拒绝 */
      assert.equal(qm.checkQuota('tenant-a', 'llm_tokens', 3_000, now), false);
    });

    it('consumeQuota 按数量原子性消费', () => {
      qm.setLimit('tenant-a', 'llm_tokens', 5_000, 3_600_000);
      const now = 100_000;

      /* 消费 3000 → 成功 */
      assert.equal(qm.consumeQuota('tenant-a', 'llm_tokens', 3_000, now), true);

      /* 再消费 2000 → 成功（3000 + 2000 = 5000 <= 5000） */
      assert.equal(qm.consumeQuota('tenant-a', 'llm_tokens', 2_000, now), true);

      /* 再消费 1 → 失败（5000 + 1 > 5000） */
      assert.equal(qm.consumeQuota('tenant-a', 'llm_tokens', 1, now), false);
    });

    it('recordUsage 按数量累加', () => {
      qm.setLimit('tenant-a', 'llm_tokens', 10_000, 3_600_000);
      const now = 100_000;

      qm.recordUsage('tenant-a', 'llm_tokens', 4_000, now);
      qm.recordUsage('tenant-a', 'llm_tokens', 3_000, now);

      /* 4000 + 3000 = 7000 已用，剩余 3000 */
      assert.equal(qm.checkQuota('tenant-a', 'llm_tokens', 3_000, now), true);
      assert.equal(qm.checkQuota('tenant-a', 'llm_tokens', 3_001, now), false);
    });
  });
});
