/**
 * 钱包账本抽象与安全不变量（ADR-0048 D2）— 纯领域逻辑，零 node:* 依赖。
 *
 * 钱包是数字人的"工资钱包"。安全铁律：
 *   - 自主流程（autonomous actor）只能 credit（赚），不能 debit（花/提）。
 *   - 任何 debit（提现/转账/付费）必须由人类确认（human actor）。
 *
 * WalletLedger 接口把钱包抽象为账本操作，当前由 Postgres 实现；
 * 未来若需上链（token / 跨平台结算），可换 ChainBackedWalletLedger 实现，
 * 上层挣钱逻辑不变（ADR-0048 区块链作为 future option，现在不上链）。
 */

import type { WalletTransactionType } from './types.js';

/** 账本操作的发起方类型——决定能否 debit */
export type WalletActorType = 'autonomous' | 'human' | 'system';

/** 资金流向 */
export type WalletDirection = 'credit' | 'debit';

/** 账本变更意图（提交给 WalletLedger 前先过安全守卫） */
export interface WalletMutationIntent {
  readonly actorType: WalletActorType;
  readonly direction: WalletDirection;
  readonly transactionType: WalletTransactionType;
  readonly amountMinor: number;
}

/**
 * 钱包账本接口（ADR-0048）。Postgres 实现见 src 层；为上链留口子。
 * 实现方必须在任何 debit 前调用 assertWalletMutationAllowed。
 */
export interface WalletLedger {
  /** 当前余额（最小货币单位，分） */
  balanceMinor(tenantId: string, personaId: string): number;
  /** 入账（赚）。返回新余额。 */
  credit(input: WalletLedgerEntry): number;
  /**
   * 出账（花/提）。仅当 actorType 非 autonomous 才允许；实现方须先过守卫。
   * 返回新余额。
   */
  debit(input: WalletLedgerEntry): number;
}

export interface WalletLedgerEntry {
  readonly tenantId: string;
  readonly personaId: string;
  readonly amountMinor: number;
  readonly transactionType: WalletTransactionType;
  readonly actorType: WalletActorType;
  readonly referenceType?: string | null;
  readonly referenceId?: string | null;
}

/** 守卫结果：允许或拒绝（带原因） */
export type WalletGuardResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * 钱包变更安全守卫（纯函数，ADR-0048 D2 铁律）。
 *
 * 规则：
 *   - credit：任何 actor 都允许（赚钱无限制方向）。
 *   - debit：autonomous actor 一律拒绝；只有 human / system（代表人类确认的
 *     已审批操作）允许。
 *   - amountMinor 必须为正（金额符号由 direction 表达，不靠负数）。
 */
export function assertWalletMutationAllowed(intent: WalletMutationIntent): WalletGuardResult {
  if (!Number.isFinite(intent.amountMinor) || intent.amountMinor <= 0) {
    return { allowed: false, reason: 'amountMinor must be a positive number' };
  }
  if (intent.direction === 'debit' && intent.actorType === 'autonomous') {
    return {
      allowed: false,
      reason: 'autonomous actor may not debit the wallet (ADR-0048: earn-only; withdrawal/transfer requires human confirmation)',
    };
  }
  return { allowed: true };
}

/** transactionType 是否本质上是 debit 方向（用于校验 direction 与类型一致） */
export function isDebitTransactionType(t: WalletTransactionType): boolean {
  return t === 'owner_payout' || t === 'platform_fee' || t === 'refund';
}
