/**
 * 结算对账服务
 * 通过 SyncWriteUnitOfWork 的 Query/Command 契约访问数据，
 * 不直接调用 db.prepare()
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { SettlementRow, WalletTransactionRow } from '@chrono/kernel';
import {
  settleQuerySettlementsByTenant, settleQueryTransactionsBySettlement,
  settleQueryTenantsWithSettlements, settleQueryRunsByTenant,
  settleCmdDeleteSettlementTransactions, settleCmdInsertTransaction,
  settleCmdDeleteOrphanTransactions, settleCmdInsertRun,
  settleCmdAcquireLock,
  signedAmountForTransaction,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

interface ExpectedLedgerEntry {
  transactionType: string;
  amountMinor: number;
  currency: string;
}

export interface SettlementReconciliationRun {
  runId: string;
  tenantId: string;
  checkedSettlements: number;
  mismatchedSettlements: number;
  repairedSettlements: number;
  deletedTransactions: number;
  insertedTransactions: number;
  orphanTransactionsRemoved: number;
  mismatchedSettlementIds: string[];
  createdAt: string;
}

function toIso(value: number): string {
  return new Date(Number(value)).toISOString();
}

function buildExpectedLedger(settlement: SettlementRow): ExpectedLedgerEntry[] {
  /* 符号统一由 signedAmountForTransaction(方向矩阵)给出，不再硬编码正负——
   * 与 PersonaWalletService 写入路径共用同一事实来源，杜绝对账期望与实际写入漂移。
   *
   * ⚠️ 审计 Warning #11：**零金额分项不产生流水**，故期望集合也必须按非零分项生成。
   * 写入侧（`settleTaskPaymentInTx`）对 platform/persona 金额为 0 时跳过插入
   * —— 钱包写入门只接受正整数，写 `-0` 会抛错并回滚整笔结算（`platformPct: 0`
   * 或 1 分钱按 60/20/20 拆分都会踩到）。两侧判据必须一致，否则合法的零分成结算
   * 会被对账**永久判为不一致**。 */
  const entries: ExpectedLedgerEntry[] = [
    {
      transactionType: 'task_payment',
      amountMinor: signedAmountForTransaction('task_payment', Number(settlement.total_amount_minor)),
      currency: settlement.currency,
    },
  ];
  const platformAmount = Number(settlement.platform_amount_minor);
  if (platformAmount > 0) {
    entries.push({
      transactionType: 'platform_fee',
      amountMinor: signedAmountForTransaction('platform_fee', platformAmount),
      currency: settlement.currency,
    });
  }
  const personaAmount = Number(settlement.persona_amount_minor);
  if (personaAmount > 0) {
    entries.push({
      transactionType: 'persona_reserve',
      amountMinor: signedAmountForTransaction('persona_reserve', personaAmount),
      currency: settlement.currency,
    });
  }
  return entries;
}

function toLedgerKey(entry: { transactionType: string; amountMinor: number; currency: string }): string {
  return `${entry.transactionType}:${entry.amountMinor}:${entry.currency}`;
}

function countLedgerEntries(entries: Array<{ transactionType: string; amountMinor: number; currency: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = toLedgerKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isLedgerConsistent(actual: readonly WalletTransactionRow[], settlement: SettlementRow): boolean {
  /* ⚠️ 条数按**期望集合**判，不能硬编码 3：零分成结算只写 1-2 条（见 buildExpectedLedger）。
   * 原来的 `actual.length !== 3` 会把合法的零分成结算永久判为不一致。
   *
   * 注：这行在逻辑上**冗余** —— 下面的多重集计数相等已蕴含条数相等
   * （各键计数相等 ⇒ 总数相等），故任何变异都无法让它单独转红（独立审查 High-2 实测：
   * 删掉本行 10 条用例仍全绿）。保留它只为**早退**与可读性，不承担正确性职责。
   * 真正的判据是下面的 `countLedgerEntries` 比较。 */
  const expected = buildExpectedLedger(settlement);
  if (actual.length !== expected.length) return false;

  const actualCounts = countLedgerEntries(actual.map((row) => ({
    transactionType: row.transaction_type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
  })));
  const expectedCounts = countLedgerEntries(expected);

  if (actualCounts.size !== expectedCounts.size) return false;
  for (const [key, value] of expectedCounts) {
    if (actualCounts.get(key) !== value) return false;
  }
  return true;
}

export class SettlementReconciliationService {
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  reconcileTenant(tenantId: string): SettlementReconciliationRun {
    const settlements = this.tx.queryMany(settleQuerySettlementsByTenant(tenantId));

    let mismatchedSettlements = 0;
    let repairedSettlements = 0;
    let deletedTransactions = 0;
    let insertedTransactions = 0;
    const mismatchedSettlementIds: string[] = [];

    for (const settlement of settlements) {
      const actual = this.tx.queryMany(settleQueryTransactionsBySettlement(tenantId, settlement.id));

      if (isLedgerConsistent(actual, settlement)) {
        continue;
      }

      mismatchedSettlements += 1;
      mismatchedSettlementIds.push(settlement.id);

      let repaired = false;
      this.tx.transaction(() => {
        /* 事务内**重新核对**再修（审计 Warning B4-7）：上面的判定发生在事务外，
         * 期间可能有并发结算补齐了流水、或另一个对账实例已经修过。
         * 若不复核就 delete/reinsert，会把并发写入的合法流水删掉，
         * 两个对账实例还会互相覆盖对方的修复结果。
         * 复核发现已一致 → 本次整体跳过（不删不插），使重复对账天然幂等。
         *
         * 两种后端的并发保护各自成立：
         *   - PostgreSQL（默认 READ COMMITTED，复核 SELECT 不加行锁）：靠下面这把
         *     pg_advisory_xact_lock 把「复核+删+重插」整段对同一 settlement 串行化，
         *     消除复核与 DELETE 之间的 TOCTOU 窗口；
         *   - SQLite：单写者 + WAL 快照隔离，写事务本就互斥（并发写会 SQLITE_BUSY
         *     回滚而非误删），锁执行器在该方言下是 no-op。 */
        this.tx.execute(settleCmdAcquireLock({ tenantId, settlementId: settlement.id }));

        const current = this.tx.queryMany(settleQueryTransactionsBySettlement(tenantId, settlement.id));
        if (isLedgerConsistent(current, settlement)) return;

        const deleted = this.tx.execute(settleCmdDeleteSettlementTransactions({
          tenantId, settlementId: settlement.id,
        }));
        deletedTransactions += deleted.rowsAffected;

        for (const expected of buildExpectedLedger(settlement)) {
          this.tx.execute(settleCmdInsertTransaction({
            id: `wtx_${randomUUID()}`,
            tenantId,
            walletId: settlement.wallet_id,
            transactionType: expected.transactionType,
            amountMinor: expected.amountMinor,
            currency: expected.currency,
            settlementId: settlement.id,
            now: Date.now(),
          }));
          insertedTransactions += 1;
        }
        repaired = true;
      });

      /* 只统计**真的修了**的：事务内复核发现已一致时不算战果，
       * 否则并发场景下 repaired 会虚高，掩盖真实的对账收敛情况。 */
      if (repaired) repairedSettlements += 1;
    }

    const orphanResult = this.tx.execute(settleCmdDeleteOrphanTransactions({ tenantId }));
    const orphanTransactionsRemoved = orphanResult.rowsAffected;

    const now = Date.now();
    const runId = `recon_${randomUUID()}`;

    this.tx.execute(settleCmdInsertRun({
      id: runId,
      tenantId,
      checkedSettlements: settlements.length,
      mismatchedSettlements,
      repairedSettlements,
      deletedTransactions,
      insertedTransactions,
      orphanTransactionsRemoved,
      reportJson: JSON.stringify({ mismatchedSettlementIds }),
      now,
    }));

    return {
      runId,
      tenantId,
      checkedSettlements: settlements.length,
      mismatchedSettlements,
      repairedSettlements,
      deletedTransactions,
      insertedTransactions,
      orphanTransactionsRemoved,
      mismatchedSettlementIds,
      createdAt: toIso(now),
    };
  }

  reconcileTenants(limit = 100): SettlementReconciliationRun[] {
    const tenantRows = this.tx.queryMany(settleQueryTenantsWithSettlements(limit));
    return tenantRows.map((row) => this.reconcileTenant(row.tenant_id));
  }

  listRuns(tenantId: string, limit = 20): SettlementReconciliationRun[] {
    const rows = this.tx.queryMany(settleQueryRunsByTenant(tenantId, limit));

    return rows.map((row) => {
      const report = JSON.parse(row.report_json) as { mismatchedSettlementIds?: string[] };
      return {
        runId: row.id,
        tenantId: row.tenant_id,
        checkedSettlements: Number(row.checked_settlements),
        mismatchedSettlements: Number(row.mismatched_settlements),
        repairedSettlements: Number(row.repaired_settlements),
        deletedTransactions: Number(row.deleted_transactions),
        insertedTransactions: Number(row.inserted_transactions),
        orphanTransactionsRemoved: Number(row.orphan_transactions_removed),
        mismatchedSettlementIds: report.mismatchedSettlementIds ?? [],
        createdAt: toIso(Number(row.created_at)),
      };
    });
  }
}
