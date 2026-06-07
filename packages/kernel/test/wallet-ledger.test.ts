import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWalletMutationAllowed,
  isDebitTransactionType,
  type WalletMutationIntent,
} from '../src/domain/persona/wallet-ledger.js';

function intent(overrides: Partial<WalletMutationIntent>): WalletMutationIntent {
  return {
    actorType: 'human', direction: 'credit', transactionType: 'task_payment', amountMinor: 100,
    ...overrides,
  };
}

describe('assertWalletMutationAllowed (ADR-0048 D2)', () => {
  it('autonomous credit 允许（赚钱无方向限制）', () => {
    const r = assertWalletMutationAllowed(intent({ actorType: 'autonomous', direction: 'credit' }));
    assert.equal(r.allowed, true);
  });

  it('autonomous debit 一律拒绝（铁律：不能自主花/提）', () => {
    const r = assertWalletMutationAllowed(intent({ actorType: 'autonomous', direction: 'debit', transactionType: 'owner_payout' }));
    assert.equal(r.allowed, false);
    if (!r.allowed) assert.match(r.reason, /autonomous actor may not debit/);
  });

  it('human debit 允许（人类确认的提现）', () => {
    const r = assertWalletMutationAllowed(intent({ actorType: 'human', direction: 'debit', transactionType: 'owner_payout' }));
    assert.equal(r.allowed, true);
  });

  it('system debit 允许（代表已审批操作）', () => {
    const r = assertWalletMutationAllowed(intent({ actorType: 'system', direction: 'debit', transactionType: 'platform_fee' }));
    assert.equal(r.allowed, true);
  });

  it('amountMinor 非正被拒（金额符号靠 direction，不靠负数）', () => {
    assert.equal(assertWalletMutationAllowed(intent({ amountMinor: 0 })).allowed, false);
    assert.equal(assertWalletMutationAllowed(intent({ amountMinor: -50 })).allowed, false);
    assert.equal(assertWalletMutationAllowed(intent({ amountMinor: NaN })).allowed, false);
  });
});

describe('isDebitTransactionType', () => {
  it('owner_payout/platform_fee/refund 为 debit', () => {
    assert.equal(isDebitTransactionType('owner_payout'), true);
    assert.equal(isDebitTransactionType('platform_fee'), true);
    assert.equal(isDebitTransactionType('refund'), true);
  });
  it('task_payment/persona_reserve 非 debit（入账）', () => {
    assert.equal(isDebitTransactionType('task_payment'), false);
    assert.equal(isDebitTransactionType('persona_reserve'), false);
  });
});
