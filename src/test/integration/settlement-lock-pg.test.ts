/**
 * PG 集成：对账串行化锁（审计 Warning B4-7 的 PG 侧闭合）。
 *
 * 背景：对账修复是「复核 → DELETE → 重插」。PostgreSQL 默认 READ COMMITTED，
 * 复核用的 SELECT **不加行锁**，复核与 DELETE 之间存在真实 TOCTOU 窗口——
 * 并发结算在此间隙写入的合法流水会被 DELETE 掉。
 * 事务内复核在 SQLite（单写者 + WAL 快照隔离）上够用，在 PG 上只是缩短窗口而非消除，
 * 这一点曾被 Codex 交叉审查明确指出。
 *
 * 修法：pg_advisory_xact_lock 把「复核+删+重插」整段对同一 settlement 串行化。
 * 本文件钉死两件事：
 *   ① 同一 settlement 的并发对账**真的互斥**（后到者被阻塞）；
 *   ② 不同 settlement **不互相阻塞**（锁粒度是 settlement 而非整租户，否则无谓拖慢）。
 *
 * 跳过条件：未设 TEST_POSTGRES_URL。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedPgSchema } from './fixtures/pg-test-schema.js';
import { settleCmdAcquireLock } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';

const TEST_URL = process.env.TEST_POSTGRES_URL;
const TENANT = 'tenant_lock';

describe('对账串行化锁 on Postgres', { skip: !TEST_URL }, () => {
  let dbA: import('../../storage/postgres-database.js').PostgresDatabase;
  let dbB: import('../../storage/postgres-database.js').PostgresDatabase;
  let cleanupA: () => Promise<void>;
  let cleanupB: () => Promise<void>;

  before(async () => {
    /* 两个**独立连接**才能构成真并发；同一连接上的事务是串行的，测不出锁。
     * 只建一个 schema（第二次调 createIsolatedPgSchema 会 DROP 重建、毁掉第一个连接的状态），
     * 第二个连接直连同一库——advisory lock 是**数据库级**对象，与 schema 无关，
     * 故两个连接天然共享同一把锁空间。 */
    const a = await createIsolatedPgSchema('settlelock', TEST_URL!, { max: 2 });
    dbA = a.db; cleanupA = a.cleanup;

    const { PostgresDatabase } = await import('../../storage/postgres-database.js');
    dbB = new PostgresDatabase(TEST_URL!, { max: 2, idleTimeoutMs: 5_000 });
    cleanupB = async (): Promise<void> => { dbB.close(); };
    registerCoreSelfExecutors();
  });

  after(async () => {
    if (cleanupB) await cleanupB();
    if (cleanupA) await cleanupA();
  });

  it('同一 settlement 并发对账互斥（后到者被阻塞至前者提交）', async () => {
    const HOLD_MS = 1200;
    let bAcquiredAt = 0;

    /* A：取锁后持有 HOLD_MS 再提交。 */
    const a = (async () => {
      dbA.exec('BEGIN');
      dbA.execute(settleCmdAcquireLock({ tenantId: TENANT, settlementId: 'st_same' }));
      await new Promise((r) => setTimeout(r, HOLD_MS));
      dbA.exec('COMMIT');
    })();

    /* 让 A 先拿到锁。 */
    await new Promise((r) => setTimeout(r, 200));

    const startedAt = Date.now();
    const b = (async () => {
      dbB.exec('BEGIN');
      dbB.execute(settleCmdAcquireLock({ tenantId: TENANT, settlementId: 'st_same' }));
      bAcquiredAt = Date.now();
      dbB.exec('COMMIT');
    })();

    await Promise.all([a, b]);

    const waited = bAcquiredAt - startedAt;
    assert.ok(
      waited >= HOLD_MS - 400,
      `B 应被阻塞到 A 提交（期望 ≥${HOLD_MS - 400}ms，实际 ${waited}ms）——锁未生效即为 TOCTOU 敞口`,
    );
  });

  it('不同 settlement 不互相阻塞（锁粒度=settlement，非整租户）', async () => {
    const HOLD_MS = 1200;
    let bAcquiredAt = 0;

    const a = (async () => {
      dbA.exec('BEGIN');
      dbA.execute(settleCmdAcquireLock({ tenantId: TENANT, settlementId: 'st_one' }));
      await new Promise((r) => setTimeout(r, HOLD_MS));
      dbA.exec('COMMIT');
    })();

    await new Promise((r) => setTimeout(r, 200));

    const startedAt = Date.now();
    const b = (async () => {
      dbB.exec('BEGIN');
      dbB.execute(settleCmdAcquireLock({ tenantId: TENANT, settlementId: 'st_two' }));
      bAcquiredAt = Date.now();
      dbB.exec('COMMIT');
    })();

    await Promise.all([a, b]);

    const waited = bAcquiredAt - startedAt;
    assert.ok(
      waited < HOLD_MS / 2,
      `不同 settlement 应立即取到锁（期望 <${HOLD_MS / 2}ms，实际 ${waited}ms）——否则锁粒度过粗`,
    );
  });
});
