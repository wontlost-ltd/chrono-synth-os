/**
 * P0-C 否定测试 — Quota 越限尝试（rate-limit subset）
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §8 #18 (P1-O-abuse W39-W42)
 *
 * **范围说明**：本测试覆盖 `QuotaManager` 业务层配额越限和跨租户隔离，
 * **不**覆盖 HTTP/fastify 层 rate-limit 中间件、DoS backpressure、LLM fallback。
 *
 * 这三项（HTTP rate-limit + DoS backpressure + LLM fallback）是 P1-O-abuse
 * (Phase 1B W39-W42) 任务的范畴；本测试是 P0-C acceptance "rate-limit bypass
 * negative" 的可执行子集，不构成完整 abuse-protection 验收。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import type { IDatabase } from '../../storage/database.js';

describe('P0-C negative — Quota 越限尝试（rate-limit subset；full HTTP rate-limit → P1-O-abuse）', () => {
  let db: IDatabase;
  let qm: QuotaManager;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    qm = new QuotaManager(db);
  });

  it('越限消费失败：consumeQuota 不可越过 max_per_window', () => {
    qm.setLimit('tenant-a', 'decisions', 3, 60_000);
    const now = 100_000;

    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, now), true);

    /* 第 4 次应失败 */
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, now), false);
  });

  it('单次大批量请求一次性越限也必拒（quantity > max_per_window）', () => {
    qm.setLimit('tenant-a', 'tokens', 100, 60_000);
    const now = 100_000;

    assert.equal(qm.consumeQuota('tenant-a', 'tokens', 101, now), false,
      'quantity 超过 max_per_window 必须直接拒绝');
  });

  it('跨租户尝试消费不会影响他租户配额', () => {
    qm.setLimit('tenant-a', 'decisions', 1, 60_000);
    qm.setLimit('tenant-b', 'decisions', 1, 60_000);
    const now = 100_000;

    /* tenant-a 用完 */
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, now), true);
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, now), false);

    /* tenant-b 仍有完整配额（独立） */
    assert.equal(qm.checkQuota('tenant-b', 'decisions', 1, now), true);
    assert.equal(qm.consumeQuota('tenant-b', 'decisions', 1, now), true);
  });

  it('窗口边界精确：旧窗口耗尽不影响新窗口', () => {
    qm.setLimit('tenant-a', 'decisions', 1, 60_000);

    /* 窗口 1 用完 */
    const window1 = 60_000;
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, window1), true);
    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, window1), false);

    /* 跳到下一个 60s 窗口 */
    const window2 = 120_000;
    assert.equal(qm.checkQuota('tenant-a', 'decisions', 1, window2), true);
  });

  it('max_per_window <= 0 等效零配额（任何请求都拒绝）', () => {
    qm.setLimit('tenant-a', 'decisions', 0, 60_000);

    assert.equal(qm.consumeQuota('tenant-a', 'decisions', 1, 100), false);
  });
});
