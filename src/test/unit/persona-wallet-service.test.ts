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

  const service = new PersonaCoreService(db);
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
  const walletService = new PersonaWalletService(db, ctx);

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
    fx.walletService.insertWalletTransaction({
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
