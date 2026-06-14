/**
 * 单元测试：QuotaUsageRetentionWorker —— 清理 quota_usage 旧窗口行。
 *
 * 核心保证：删旧窗口不影响当前窗口计量（consumeQuota/checkQuota 只读当前窗口）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { QuotaUsageRetentionWorker } from '../../multi-tenant/quota-usage-retention-worker.js';
import { SilentLogger } from '../../utils/logger.js';
import type { IDatabase } from '../../storage/database.js';

function countUsage(db: IDatabase): number {
  return db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM quota_usage').get()?.c ?? 0;
}

function setup() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const qm = new QuotaManager(db);
  const worker = new QuotaUsageRetentionWorker(qm, new SilentLogger(), {
    intervalMs: 60_000,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    batchSize: 100,
    maxBatchesPerCycle: 5,
  });
  return { db, qm, worker };
}

const DAY = 24 * 60 * 60 * 1000;

describe('QuotaUsageRetentionWorker', () => {
  it('flushOnce 删除超期旧窗口，保留近窗口', async () => {
    const { db, qm, worker } = setup();
    const now = 100 * DAY;
    /* 旧窗口（30 天前）+ 近窗口（1 天前），用按窗口对齐的 recordUsage 落两行。 */
    qm.setLimit('t1', 'decisions', 10, DAY);
    qm.recordUsage('t1', 'decisions', 1, now - 30 * DAY);
    qm.recordUsage('t1', 'decisions', 1, now - 1 * DAY);
    assert.equal(countUsage(db), 2);

    const res = await worker.flushOnce(now);
    assert.equal(res.deleted, 1, '只删 1 条超 7 天的旧窗口');
    assert.equal(countUsage(db), 1, '近窗口保留');
  });

  it('删旧窗口不影响当前窗口计量', async () => {
    const { qm, worker } = setup();
    const now = 100 * DAY;
    qm.setLimit('t1', 'api', 3, DAY);
    /* 旧窗口用满（但已过期，与当前无关） + 当前窗口用 1。 */
    qm.recordUsage('t1', 'api', 3, now - 30 * DAY);
    qm.consumeQuota('t1', 'api', 1, now);

    await worker.flushOnce(now);

    /* 当前窗口仍有 2 配额（旧窗口删了也不影响）。 */
    assert.equal(qm.checkQuota('t1', 'api', 2, now), true);
    assert.equal(qm.checkQuota('t1', 'api', 3, now), false, '当前窗口已用 1，剩 2，要 3 超额');
  });

  it('无旧窗口时 deleted=0（幂等空跑）', async () => {
    const { qm, worker } = setup();
    const now = 100 * DAY;
    qm.recordUsage('t1', 'x', 1, now);
    const res = await worker.flushOnce(now);
    assert.equal(res.deleted, 0);
  });

  it('分批：超 batchSize 旧窗口分多批删完', async () => {
    const { db, qm, worker } = setup();
    const now = 1000 * DAY;
    /* 落 250 条不同旧窗口（resource 不同避开组合主键冲突）。 */
    for (let i = 0; i < 250; i++) {
      qm.recordUsage('t1', `res_${i}`, 1, now - 30 * DAY);
    }
    assert.equal(countUsage(db), 250);
    /* batchSize=100, maxBatchesPerCycle=5 → 一周期最多 500，足够清完 250。 */
    const res = await worker.flushOnce(now);
    assert.equal(res.deleted, 250);
    assert.ok(res.batches >= 3, '至少 3 批（250/100）');
    assert.equal(countUsage(db), 0);
  });
});
