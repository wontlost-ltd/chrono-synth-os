/**
 * 组织金库结算 service（org wallet settlement, S3）——把「组织从市场工单赚的钱」确定性结算入组织金库。
 *
 * 与 persona 版（PersonaMarketplaceService.settleTaskPayment）的关键差异：
 *   - persona 版三方分账（owner/persona/platform，钱进人格主人个人钱包）；
 *   - org 版**两方分账**：平台抽成 platformAmount + 组织净留存 orgAmount(=total-platform) 入组织金库。
 *     组织没有「persona 储备」概念——金库就是组织自己的钱。
 *
 * 幂等：以 sourceMarketplaceTaskId 为键，同一工单只结算一次（已结算 → 返回既有记录，不重复入账）。
 * 原子：结算记录 + 金库入账 + 两笔流水包在单事务，失败整体回滚。确定性（金额拆分纯算术，无随机/网络）。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgWalletSettlement } from './types.js';

export interface SettleOrgTaskPaymentInput {
  readonly orgId: string;
  /** 结算对应的市场工单 id（幂等键 + 溯源）。 */
  readonly sourceMarketplaceTaskId: string;
  /** 该工单接来的组织目标 id（审计关联；可空）。 */
  readonly goalId: string | null;
  /** 工单总报酬（minor 单位，分）。须 > 0。 */
  readonly totalAmountMinor: number;
  readonly currency: string;
  /** 平台抽成比例（%，0-100）；组织净留存 = total - platform。 */
  readonly platformPct: number;
}

export class OrgWalletService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string,
  ) {}

  /**
   * 结算一个市场工单的报酬入组织金库。幂等（同工单只结算一次）+ 原子。
   * 返回结算记录；入参非法（金额≤0 / 抽成越界 / 金库冻结）→ 返回 null。
   */
  settleOrgTaskPayment(input: SettleOrgTaskPaymentInput): OrgWalletSettlement | null {
    if (!this.validate(input)) return null;
    /* 幂等：已结算过 → 直接返回既有（不重复入账）。 */
    const existing = this.store.getOrgWalletSettlementBySourceTask(input.sourceMarketplaceTaskId);
    if (existing) return existing;
    /* 公开 API 语义：金库冻结 → 返回 null（不抛）。事务前先查，避免 settleInTx 在事务内抛错 rollback。
     * （getOrCreate 幂等：金库不存在则建 active，下一行不会因此误判冻结。） */
    const probe = this.store.getOrgWallet(input.orgId);
    if (probe && probe.status !== 'active') return null;
    return this.store.transaction(() => this.settleInTx(input));
  }

  /**
   * 结算核心（**不自开事务**）——供已在事务中的调用方复用（如 OrgBiddingService.acceptOrgTask，
   * 它在自己的事务里更新指派/工单状态 + 结算，需同一事务原子）。SQLite 事务不可重入，故抽此变体。
   * 返回结算记录；金库冻结 → 抛错（由外层事务回滚）。入参校验由调用方先做（settleOrgTaskPayment 或 acceptOrgTask）。
   */
  settleInTx(input: SettleOrgTaskPaymentInput): OrgWalletSettlement {
    /* 事务内二次幂等校验：防并发两路同时穿过 existing 检查（DB UNIQUE 兜底，这里先查避免抛错）。 */
    const racey = this.store.getOrgWalletSettlementBySourceTask(input.sourceMarketplaceTaskId);
    if (racey) return racey;

    const total = Math.round(input.totalAmountMinor);
    const platformPct = Math.round(input.platformPct);
    const now = this.now();
    const wallet = this.store.getOrCreateOrgWallet(input.orgId, this.idgen(), now, input.currency);
    if (wallet.status !== 'active') throw new Error(`org wallet 冻结，禁结算：org=${input.orgId}`);

    /* 两方分账（确定性算术）：platform 向下取整，org 拿余下（保证 platform+org=total，无尾差丢失）。 */
    const platformAmount = Math.floor(total * platformPct / 100);
    const orgAmount = total - platformAmount;
    const settlementId = this.idgen();

    this.store.insertOrgWalletSettlement({
      id: settlementId, orgId: input.orgId, walletId: wallet.id,
      sourceMarketplaceTaskId: input.sourceMarketplaceTaskId, goalId: input.goalId,
      totalAmountMinor: total, currency: input.currency,
      platformPct, platformAmountMinor: platformAmount, orgAmountMinor: orgAmount,
      createdAt: now,
    });
    const credited = this.store.creditOrgWallet(input.orgId, orgAmount, now);
    if (credited === null) throw new Error(`org wallet 入账失败（金库冻结或并发改走）：org=${input.orgId}`);

    /* 两笔流水：报酬入账(+total) + 平台抽成(-platform)。净额 = org 入账。 */
    this.store.insertOrgWalletTransaction({
      id: this.idgen(), walletId: wallet.id, transactionType: 'task_payment',
      amountMinor: total, currency: input.currency,
      referenceType: 'org_wallet_settlement', referenceId: settlementId, createdAt: now,
    });
    this.store.insertOrgWalletTransaction({
      id: this.idgen(), walletId: wallet.id, transactionType: 'platform_fee',
      amountMinor: -platformAmount, currency: input.currency,
      referenceType: 'org_wallet_settlement', referenceId: settlementId, createdAt: now,
    });

    const settled = this.store.getOrgWalletSettlementBySourceTask(input.sourceMarketplaceTaskId);
    if (!settled) throw new Error(`结算后查不到记录（数据异常）：task=${input.sourceMarketplaceTaskId}`);
    return settled;
  }

  /** 入参校验（金额>0 / 抽成 0-100）。非法 → false。 */
  validate(input: SettleOrgTaskPaymentInput): boolean {
    const total = Math.round(input.totalAmountMinor);
    if (total <= 0) return false;
    const platformPct = Math.round(input.platformPct);
    return platformPct >= 0 && platformPct <= 100;
  }
}
