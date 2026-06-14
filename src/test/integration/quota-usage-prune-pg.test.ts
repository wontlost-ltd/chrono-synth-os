/**
 * PG 集成：quota_usage retention prune 在**真 Postgres** 上的可移植性 + 长窗口安全性。
 *
 * prune SQL 用了行值元组 IN + LEFT JOIN quota_limits + 取模（% window_ms）算当前窗口——这些组合在
 * SQLite 已测，但 PG 路径（? → $N 占位符转换、行值 IN、% 语义）值得真库验证（Codex #121 建议）。
 * 跳过条件：未设 TEST_POSTGRES_URL。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.TEST_POSTGRES_URL;
const DAY = 24 * 60 * 60 * 1000;

describe('quota_usage prune on Postgres', { skip: !TEST_URL }, () => {
  let db: import('../../storage/postgres-database.js').PostgresDatabase;
  let QuotaManager: typeof import('../../multi-tenant/quota-manager.js').QuotaManager;
  let qm: import('../../multi-tenant/quota-manager.js').QuotaManager;

  before(async () => {
    const pgMod = await import('../../storage/postgres-database.js');
    const migMod = await import('../../storage/index.js');
    const qmMod = await import('../../multi-tenant/quota-manager.js');
    QuotaManager = qmMod.QuotaManager;
    db = new pgMod.PostgresDatabase(TEST_URL!, { max: 3, idleTimeoutMs: 10_000 });
    db.exec('DROP TABLE IF EXISTS quota_usage CASCADE');
    db.exec('DROP TABLE IF EXISTS quota_limits CASCADE');
    db.exec('DROP TABLE IF EXISTS schema_migrations CASCADE');
    migMod.runDslPostgresMigrations(db);
    qm = new QuotaManager(db);
  });

  after(() => { if (db) db.close(); });

  it('行值 IN + JOIN + 取模 prune 在 PG 上跑通：删旧窗口、保留近窗口', () => {
    const now = 100 * DAY;
    qm.setLimit('t1', 'decisions', 10, DAY);
    qm.recordUsage('t1', 'decisions', 1, now - 30 * DAY);
    qm.recordUsage('t1', 'decisions', 1, now - 1 * DAY);
    /* cutoff = now-7d；当前 1d 窗口 = now-(now%1d)=now（now 是 1d 整数倍）→ 近窗口(now-1d) 也 < 当前但 ≥ cutoff，保留。 */
    const deleted = qm.pruneUsageBefore(now, now - 7 * DAY, 100);
    assert.equal(deleted, 1, '只删 30d 前旧窗口');
    const rows = db.prepare<{ c: string }>("SELECT COUNT(*) AS c FROM quota_usage WHERE resource = 'decisions'").get();
    assert.equal(Number(rows!.c), 1);
  });

  it('长窗口（window_ms > retention）：当前窗口绝不被删（PG 路径同样安全）', () => {
    const now = 100 * DAY;
    qm.setLimit('t1', 'big', 5, 30 * DAY);
    qm.consumeQuota('t1', 'big', 5, now);  /* 当前 30d 窗口起点 = 90d */
    const deleted = qm.pruneUsageBefore(now, now - 7 * DAY, 100);
    assert.equal(deleted, 0, '当前长窗口虽早于 cutoff 仍不删');
    assert.equal(qm.checkQuota('t1', 'big', 1, now), false, '当前窗口用量未被清零');
  });
});
