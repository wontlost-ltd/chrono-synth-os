/**
 * PG 集成：钱包提现的条件原子扣减在**真 Postgres** 上的可移植性。
 *
 * 为什么必须有这个文件（审计 Warning B3-2 的教训）：修复丢更新时写的
 * `ROUND(balance * 100)` 在 SQLite 上完全正常，SQLite-only 的单测也全绿——
 * 但 PostgreSQL **没有** `round(double precision, integer)` 重载，该语句在 PG 上
 * 直接报 "function round(double precision, integer) does not exist"，即**所有提现
 * 全部失败**，比原本要修的丢更新更糟。是 Codex 交叉审查指出方言差异后，在真实
 * PG 17 上复现才发现。
 *
 * 故此处钉死两件事：
 *   ① 扣减 SQL 在 PG 上能真正执行（CAST(... AS numeric) 的可移植形式）；
 *   ② 余额不足时 rowsAffected=0（条件谓词在 PG 上语义与 SQLite 一致）。
 *
 * 跳过条件：未设 TEST_POSTGRES_URL。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedPgSchema } from './fixtures/pg-test-schema.js';
import { pcoreCmdDebitWalletBalance } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';

const TEST_URL = process.env.TEST_POSTGRES_URL;

describe('钱包条件原子扣减 on Postgres', { skip: !TEST_URL }, () => {
  let db: import('../../storage/postgres-database.js').PostgresDatabase;
  let cleanup: () => Promise<void>;

  const TENANT = 'tenant_pg';
  const WALLET = 'wallet_pg_1';
  const PERSONA = 'persona_pg_1';
  const OWNER = 'user_pg_1';

  before(async () => {
    const iso = await createIsolatedPgSchema('walletpayout', TEST_URL!, { max: 3 });
    db = iso.db;
    cleanup = iso.cleanup;
    registerCoreSelfExecutors();
  });

  after(async () => { if (cleanup) await cleanup(); });

  /**
   * 每个用例前把余额重置为指定值（元）。
   *
   * 先插 users → persona_core 两级父行：PG **真正执行**外键约束（SQLite 默认不开），
   * 少一级就会 violates foreign key constraint。这本身也是一处方言差异的提醒。
   */
  function setBalance(balance: number): void {
    db.prepare<void>('DELETE FROM persona_wallets WHERE id = ?').run(WALLET);
    db.prepare<void>(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'member', 0, 0) ON CONFLICT (id) DO NOTHING`,
    ).run(OWNER, TENANT, `${OWNER}@example.test`);
    db.prepare<void>(
      `INSERT INTO persona_core (id, tenant_id, owner_user_id, display_name, profile_json,
         status, visibility, growth_index, created_at, updated_at)
       VALUES (?, ?, ?, 'PG 测试人格', '{}', 'active', 'private', 0, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    ).run(PERSONA, TENANT, OWNER);
    db.prepare<void>(
      `INSERT INTO persona_wallets (id, tenant_id, persona_id, wallet_address, balance, token_balance,
         currency, status, last_settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'CRED', 'active', NULL, 0, 0)`,
    ).run(WALLET, TENANT, PERSONA, `addr_${WALLET}`, balance);
  }

  function balanceOf(): number {
    const row = db.prepare<{ balance: string | number }>(
      'SELECT balance FROM persona_wallets WHERE id = ?',
    ).get(WALLET);
    return Number(row!.balance);
  }

  it('扣减 SQL 在 PG 上可执行（real 列 + ROUND 的方言陷阱）', () => {
    setBalance(100);
    const r = db.execute(pcoreCmdDebitWalletBalance({
      tenantId: TENANT, walletId: WALLET, amountMinor: 8000, now: 1,
    }));
    assert.equal(r.rowsAffected, 1, '余额充足应扣减成功');
    assert.equal(balanceOf(), 20, '100 - 80 = 20');
  });

  it('余额不足 → rowsAffected=0 且余额不变（谓词语义与 SQLite 一致）', () => {
    setBalance(20);
    const r = db.execute(pcoreCmdDebitWalletBalance({
      tenantId: TENANT, walletId: WALLET, amountMinor: 8000, now: 2,
    }));
    assert.equal(r.rowsAffected, 0, '余额不足必须拒绝');
    assert.equal(balanceOf(), 20, '余额不得被扣成负数');
  });

  it('恰好扣空 → 成功清零（谓词用 >= 而非 >）', () => {
    setBalance(42.5);
    const r = db.execute(pcoreCmdDebitWalletBalance({
      tenantId: TENANT, walletId: WALLET, amountMinor: 4250, now: 3,
    }));
    assert.equal(r.rowsAffected, 1);
    assert.equal(balanceOf(), 0);
  });

  it('跨租户不可扣减（tenant 谓词在 PG 上同样生效）', () => {
    setBalance(100);
    const r = db.execute(pcoreCmdDebitWalletBalance({
      tenantId: 'tenant_other', walletId: WALLET, amountMinor: 1000, now: 4,
    }));
    assert.equal(r.rowsAffected, 0);
    assert.equal(balanceOf(), 100);
  });
});
