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

  /* ── type ↔ direction 矩阵（ADR-0048 钱的正确性铁律） ── */

  it('每种 transactionType 的合法方向通过', () => {
    const legal: Array<[WalletMutationIntent['transactionType'], WalletMutationIntent['direction'], WalletMutationIntent['actorType']]> = [
      ['task_payment', 'credit', 'system'],
      ['platform_fee', 'debit', 'system'],
      ['owner_payout', 'debit', 'human'],
      ['persona_reserve', 'debit', 'system'],
      ['refund', 'debit', 'human'],
    ];
    for (const [transactionType, direction, actorType] of legal) {
      const r = assertWalletMutationAllowed(intent({ transactionType, direction, actorType }));
      assert.equal(r.allowed, true, `${transactionType} ${direction} 应合法`);
    }
  });

  it('方向错配一律拒绝（杜绝语义错配，如 owner_payout 当 credit 入账）', () => {
    const illegal: Array<[WalletMutationIntent['transactionType'], WalletMutationIntent['direction']]> = [
      ['owner_payout', 'credit'],    /* 提现不能是入账 */
      ['platform_fee', 'credit'],    /* 平台费不能是入账 */
      ['persona_reserve', 'credit'], /* 预留不能是入账 */
      ['refund', 'credit'],          /* 退款不能是入账 */
      ['task_payment', 'debit'],     /* 任务报酬不能是出账 */
    ];
    for (const [transactionType, direction] of illegal) {
      const r = assertWalletMutationAllowed(intent({ transactionType, direction, actorType: 'system' }));
      assert.equal(r.allowed, false, `${transactionType} ${direction} 应被拒`);
      if (!r.allowed) assert.match(r.reason, /direction matrix|must be/);
    }
  });
});

describe('isDebitTransactionType', () => {
  it('owner_payout/platform_fee/refund/persona_reserve 为 debit', () => {
    assert.equal(isDebitTransactionType('owner_payout'), true);
    assert.equal(isDebitTransactionType('platform_fee'), true);
    assert.equal(isDebitTransactionType('refund'), true);
    /* persona_reserve 实际结算写入是负数（debit）——修正旧 helper 的错误分类 */
    assert.equal(isDebitTransactionType('persona_reserve'), true);
  });
  it('task_payment 非 debit（入账 credit）', () => {
    assert.equal(isDebitTransactionType('task_payment'), false);
  });
});
