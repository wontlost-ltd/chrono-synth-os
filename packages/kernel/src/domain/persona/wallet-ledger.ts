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
 * 每种 transactionType 的**唯一合法资金流向**（ADR-0048）。
 *
 * 方向由各 type 的业务语义决定，且都从实际写入点逐一核验（见
 * .claude/context-wallet-direction.json 的证据）：
 *   - task_payment   → credit：结算把任务报酬入账（数字人赚钱，+）。
 *   - platform_fee   → debit：从报酬中扣平台抽成（-）。
 *   - owner_payout   → debit：owner 提现，减余额（-）。
 *   - persona_reserve→ debit：结算把 persona 份额从工资钱包划出预留（-）。
 *   - refund         → debit：退款减数字人余额（-）。
 *
 * 这 5 种 type 语义都是单向的（无双向 type），故用 type→direction 的一一映射。
 * 防止 type 与方向语义错配（如 owner_payout 被当作 credit 入账）。
 */
export const WALLET_DIRECTION_MATRIX: Readonly<Record<WalletTransactionType, WalletDirection>> = {
  task_payment: 'credit',
  platform_fee: 'debit',
  owner_payout: 'debit',
  persona_reserve: 'debit',
  refund: 'debit',
};

/**
 * 按方向矩阵给出某 transactionType 的**带符号金额**（credit 正、debit 负）。
 *
 * 单一事实来源：任何「按 type 决定符号」的写入方（结算、对账修复）都应调用本函数，
 * 而非各自硬编码正负，避免与 WALLET_DIRECTION_MATRIX 漂移。
 * @param magnitude 金额绝对值（正整数，最小货币单位）
 */
export function signedAmountForTransaction(transactionType: WalletTransactionType, magnitude: number): number {
  const abs = Math.abs(magnitude);
  return WALLET_DIRECTION_MATRIX[transactionType] === 'debit' ? -abs : abs;
}

/**
 * 钱包变更安全守卫（纯函数，ADR-0048 D2 铁律）。
 *
 * 入参约定：本守卫的 `amountMinor` 是**绝对值（必须为正）**，方向由独立的 `direction`
 * 字段表达——调用方（如 PersonaWalletService）从带符号金额推导出 `direction` 后，传入
 * `Math.abs(amount)` 作为 amountMinor。守卫不看符号，只看 direction 字段。
 *
 * 规则：
 *   - amountMinor 必须为**正整数**（最小货币单位，分；不接受小数——否则 0.4 会过守卫
 *     却被下游 round 成 0，凭空蒸发资金）。符号由 direction 字段表达，不靠负数。
 *   - transactionType ↔ direction 必须与 WALLET_DIRECTION_MATRIX 一致——杜绝语义错配
 *     （如 owner_payout 当 credit、task_payment 当 debit），这是钱的正确性铁律。
 *   - debit：autonomous actor 一律拒绝；只有 human / system（代表人类确认的
 *     已审批操作）允许。credit：任何 actor 都允许（赚钱无限制方向）。
 */
export function assertWalletMutationAllowed(intent: WalletMutationIntent): WalletGuardResult {
  if (!Number.isInteger(intent.amountMinor) || intent.amountMinor <= 0) {
    return { allowed: false, reason: 'amountMinor must be a positive integer (minor currency unit)' };
  }
  const expectedDirection = WALLET_DIRECTION_MATRIX[intent.transactionType];
  if (intent.direction !== expectedDirection) {
    return {
      allowed: false,
      reason: `transactionType '${intent.transactionType}' must be ${expectedDirection}, got ${intent.direction} (ADR-0048 direction matrix)`,
    };
  }
  if (intent.direction === 'debit' && intent.actorType === 'autonomous') {
    return {
      allowed: false,
      reason: 'autonomous actor may not debit the wallet (ADR-0048: earn-only; withdrawal/transfer requires human confirmation)',
    };
  }
  return { allowed: true };
}

/** transactionType 是否本质上是 debit 方向（由方向矩阵派生，单一事实来源）。 */
export function isDebitTransactionType(t: WalletTransactionType): boolean {
  return WALLET_DIRECTION_MATRIX[t] === 'debit';
}
