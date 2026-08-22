/**
 * Step 16b — PersonaWalletService extraction tests.
 *
 * Pairs with the Step 16 memory-service split. Same testing pattern:
 * exercise the sub-service directly + a behaviour-equivalence assertion
 * against the facade so future drift is caught at the seam.
 *
 * Coverage:
 *   - getWallet returns null when persona-existence guard fails.
 *   - getWalletByIdForOwner enforces owner_user_id match.
 *   - listWalletTransactions requires the owner check; returns the row
 *     mapping for journal entries.
 *   - requestWalletPayout: amount > balance → null (no write);
 *     amount ≤ balance → row + balance updated + journal entry.
 *   - insertWalletTransaction journal entry survives a read-back.
 *   - Behaviour-equivalence: facade.getWallet === walletService.getWallet
 *     for the same persona.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import {
  PersonaWalletService,
  type PersonaWalletContext,
} from '../../persona-core/persona-wallet-service.js';

interface Fixture {
  db: IDatabase;
  service: PersonaCoreService;
  walletService: PersonaWalletService;
  personaId: string;
  walletId: string;
  tenantId: string;
  ownerUserId: string;
}

function setup(): Fixture {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const tenantId = 'tenant_test';
  const ownerUserId = 'user_test_owner';
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, 'owner@example.com', 'hash', 'member', tenantId, now, now);

  const service = PersonaCoreService.fromUnitOfWork(db);
  const persona = service.createPersona({
    tenantId,
    ownerUserId,
    displayName: 'Wallet Test',
    profile: {},
  });
  const walletId = persona.wallet.id;

  const ctx: PersonaWalletContext = {
    personaExists: (t, o, p) => {
      const d = service.getPersonaDetail(t, o, p);
      return d !== null;
    },
  };
  const walletService = new PersonaWalletService({ forTenant: () => db, allDbs: () => [db] }, ctx);

  return { db, service, walletService, personaId: persona.id, walletId, tenantId, ownerUserId };
}

describe('PersonaWalletService (Step 16b extraction)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setup();
  });

  it('getWallet returns null when the persona-existence guard fails', () => {
    const result = fx.walletService.getWallet(fx.tenantId, 'wrong-owner', fx.personaId);
    assert.equal(result, null);
  });

  it('getWallet returns the wallet for the correct owner', () => {
    const wallet = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.ok(wallet);
    assert.equal(wallet?.personaId, fx.personaId);
    assert.equal(wallet?.balance, 0);
  });

  it('getWalletByIdForOwner returns null when owner_user_id mismatches', () => {
    const result = fx.walletService.getWalletByIdForOwner(fx.tenantId, 'wrong-owner', fx.walletId);
    assert.equal(result, null);
  });

  it('listWalletTransactions returns null when owner check fails', () => {
    const result = fx.walletService.listWalletTransactions(fx.tenantId, 'wrong-owner', fx.walletId);
    assert.equal(result, null);
  });

  it('insertWalletTransaction writes a journal entry visible via list', () => {
    fx.walletService.insertWalletTransactionInTx(fx.db, {
      tenantId: fx.tenantId,
      walletId: fx.walletId,
      transactionType: 'task_payment',
      amountMinor: 5000,
      currency: 'CRED',
      referenceType: 'test',
      referenceId: 'ref-1',
    });
    const txs = fx.walletService.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId);
    assert.ok(txs);
    assert.ok(txs!.length >= 1);
    const entry = txs!.find((t) => t.referenceId === 'ref-1');
    assert.ok(entry);
    assert.equal(entry?.amountMinor, 5000);
  });

  it('requestWalletPayout refuses amounts exceeding the wallet balance', () => {
    /* Fresh wallet has balance=0 — any positive payout should fail. */
    const result = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      walletId: fx.walletId,
      amountMinor: 100,
    });
    assert.equal(result, null);
  });

  it('requestWalletPayout writes a payout row + journal entry + balance update on success', () => {
    /* Top up the wallet via a direct insertWalletTransaction so we
     * can exercise the payout path. The balance column is updated
     * separately by settleTaskPayment in real flows; for this test
     * we simulate having funds by directly touching the row. */
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(100, now, fx.walletId);

    const payout = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      walletId: fx.walletId,
      amountMinor: 5000, /* $50 of $100 */
    });
    assert.ok(payout);
    assert.equal(payout?.amountMinor, 5000);
    /* The kernel command sets status=`completed` immediately since
     * the off-platform payout is not modeled here. The point of the
     * assertion is that the row exists with the requested amount. */
    assert.ok(['pending', 'completed'].includes(payout!.status));

    /* Wallet balance should have dropped by $50 → $50 remaining. */
    const wallet = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(wallet?.balance, 50);

    /* The journal should carry an owner_payout entry. */
    const txs = fx.walletService.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId);
    assert.ok(txs!.some((t) => t.transactionType === 'owner_payout' && t.amountMinor === -5000));
  });

  /* 审计 Warning B3-2：余额在事务**外**读取，事务内写入预先算好的绝对值。
   * 余额 100 的钱包并发提现两笔 80，两者都读到 100、都写 20——账面只扣一次，
   * 却产生两条 80 的提现记录（凭空多出 80）。
   *
   * requestWalletPayout 是同步方法，无法用真并发触发；这里模拟交错的**后果**：
   * 第一笔提现落库后，用第二个持有陈旧余额视图的调用再次提现。条件原子扣减
   * （相对扣减 + 同语句余额校验）必须拒绝它。 */
  it('并发提现不产生丢更新：余额不足的第二笔被原子扣减拒绝', () => {
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(100, now, fx.walletId);

    /* 第一笔：$80 成功，余额剩 $20。 */
    const first = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 8000,
    });
    assert.ok(first, '第一笔提现应成功');

    /* 第二笔：同样 $80。余额只剩 $20，必须被拒。 */
    const second = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 8000,
    });
    assert.equal(second, null, '余额不足的第二笔必须被拒绝');

    /* 关键不变量：余额恰好扣一次，且只有一条提现流水。 */
    const wallet = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(wallet?.balance, 20, '余额必须恰好扣一次');

    const txs = fx.walletService.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId);
    const payouts = txs!.filter((t) => t.transactionType === 'owner_payout');
    assert.equal(payouts.length, 1, '只应有一条提现流水（被拒的那笔不得留痕）');
  });

  /* 上一条只证明了事务外的快速失败检查有效——它在 SQL 之前就拦下了第二笔。
   * 要真正把守条件原子扣减，必须让**事务外读到的余额是陈旧的**（高于库中真实值），
   * 这正是并发交错的真实形态：A 读到 100 → B 扣到 20 → A 才带着 100 的视图去写。 */
  it('陈旧余额视图下：条件原子扣减仍拒绝超额提现（真并发交错）', () => {
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(20, now, fx.walletId);   /* 库中真实余额只剩 $20 */

    /* 伪造「事务外读到 $100」的陈旧快照，绕过快速失败检查，逼出 SQL 层判定。 */
    const stale = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId)!;
    const spy = Object.create(fx.walletService) as PersonaWalletService;
    spy.getWalletByIdForOwner = (): typeof stale => ({ ...stale, balance: 100 });

    const result = spy.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 8000,  /* $80 > 真实余额 $20 */
    });

    assert.equal(result, null, '陈旧视图放行后，SQL 层的余额校验必须拒绝');
    const wallet = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(wallet?.balance, 20, '余额不得被扣成负数');

    const txs = fx.walletService.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId);
    assert.equal(
      txs!.filter((t) => t.transactionType === 'owner_payout').length, 0,
      '被拒的提现不得留下流水',
    );
  });

  it('提现被拒时整体回滚：不留下提现请求行', () => {
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(10, now, fx.walletId);

    /* 余额 $10，提现 $10 成功；再提 $10 必被拒。 */
    assert.ok(fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 1000,
    }));
    assert.equal(fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 1000,
    }), null);

    /* 被拒那笔的 payout_request 行不得残留（事务须整体回滚）。 */
    const rows = fx.db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wallet_payout_requests WHERE wallet_id = ?`,
    ).get(fx.walletId);
    assert.equal(Number(rows?.n), 1, '只应有一条提现请求行');
  });

  /* 边界：恰好提空余额必须成功（校验用 >=，不能写成 >）。 */
  it('提现恰好等于余额：成功清零', () => {
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(42.5, now, fx.walletId);

    assert.ok(fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 4250,
    }), '提现恰好等于余额应成功');
    const wallet = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(wallet?.balance, 0);
  });

  it('同一 idempotencyKey 重复提现只扣一次（审计 P4：领域幂等锚）', () => {
    /* 缺陷：`requestWalletPayout` 只收 (walletId, amountMinor)，**没有任何幂等键**。
     * 客户端重试、或 HTTP `Idempotency-Key` 的 TTL（默认 24h）过期后重放，会各扣一次。
     * 实测（无锚时）：余额 1000 的钱包连发两次 10000 分提现 → 两条请求、余额 **1000 → 800**。
     *
     * HTTP 幂等插件不够：它把 claim 与业务写入放在**两个**事务里 —— claim 后崩溃、
     * 或 TTL 清理后重放，业务侧没有任何东西能识别「这笔已处理过」。
     * 金融幂等必须锚在领域数据上，由 `(tenant_id, idempotency_key)` 唯一索引兜底。 */
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(100, now, fx.walletId);

    const key = 'idem-payout-1';
    const first = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 1000, idempotencyKey: key,
    });
    assert.ok(first, '首次提现应成功');

    const second = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId,
      walletId: fx.walletId, amountMinor: 1000, idempotencyKey: key,
    });
    assert.ok(second, '重复提交应幂等成功（返回既有请求），而不是抛错');
    assert.equal(second?.id, first?.id, '必须返回**同一条**提现请求');

    const rows = fx.db.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM wallet_payout_requests WHERE wallet_id = ?',
    ).all(fx.walletId);
    assert.equal(rows[0]?.c, 1, '只应有一条提现请求');

    const wallet = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.equal(wallet?.balance, 90, '余额只扣一次（100 - 10），不得扣成 80');
  });

  it('不传 idempotencyKey 时保持既有行为（向后兼容：仍可重复提交）', () => {
    /* 幂等是**调用方选择加入**的能力。不传 key 的既有调用方行为一字不变，
     * 否则这就成了破坏性变更。部分唯一索引的 `WHERE key IS NOT NULL` 保证
     * 多条 NULL 可共存。 */
    const now = Date.now();
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(100, now, fx.walletId);

    assert.ok(fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, walletId: fx.walletId, amountMinor: 1000,
    }));
    assert.ok(fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId, ownerUserId: fx.ownerUserId, walletId: fx.walletId, amountMinor: 1000,
    }));

    const rows = fx.db.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM wallet_payout_requests WHERE wallet_id = ?',
    ).all(fx.walletId);
    assert.equal(rows[0]?.c, 2, '无 key 时两次提交应各留一条（既有行为）');
  });

  it('facade and sub-service return byte-equal wallets for the same persona', () => {
    const viaFacade = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    const viaSub = fx.walletService.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId);
    assert.deepEqual(viaFacade, viaSub);

    const txsFacade = fx.service.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId);
    const txsSub = fx.walletService.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId);
    assert.deepEqual(txsFacade, txsSub);
  });

  it('requestWalletPayout: facade and sub-service produce equivalent post-state', () => {
    /* Highest-value moved workflow — lock in that the facade
     * delegation produces the same final wallet balance + journal
     * entry shape as a direct sub-service call. We can't compare
     * full payout objects (ids + timestamps differ) so we compare
     * the resulting wallet state + transaction-type signature. */
    const now = Date.now();
    /* Top up both via the journal directly so we don't double-write. */
    fx.db.prepare<void>(
      `UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`,
    ).run(200, now, fx.walletId);

    /* Path A: payout via the facade. */
    const facadePayout = fx.service.requestWalletPayout({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      walletId: fx.walletId,
      amountMinor: 3000,
    });
    assert.ok(facadePayout);

    const balanceAfterFacade = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId)?.balance;

    /* Path B: another payout via the sub-service directly. */
    const subPayout = fx.walletService.requestWalletPayout({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      walletId: fx.walletId,
      amountMinor: 4000,
    });
    assert.ok(subPayout);

    const balanceAfterSub = fx.service.getWallet(fx.tenantId, fx.ownerUserId, fx.personaId)?.balance;

    /* Both wallet objects must carry the same shape — currency,
     * status, persona binding — and the journal entries must
     * follow the same conventions (negative amount on owner_payout). */
    const txs = fx.walletService.listWalletTransactions(fx.tenantId, fx.ownerUserId, fx.walletId)!;
    const payoutEntries = txs.filter((t) => t.transactionType === 'owner_payout');
    assert.equal(payoutEntries.length, 2);
    for (const entry of payoutEntries) {
      assert.ok(entry.amountMinor < 0, 'owner_payout should be a debit');
      assert.equal(entry.currency, 'CRED');
    }
    /* Balance should have decreased by exactly the sum of the
     * payouts on both paths (200 - 30 - 40 = 130). */
    assert.equal(balanceAfterFacade, 170);
    assert.equal(balanceAfterSub, 130);
  });
});
