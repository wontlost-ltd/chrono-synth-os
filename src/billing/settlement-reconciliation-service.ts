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
   * 与 PersonaWalletService 写入路径共用同一事实来源，杜绝对账期望与实际写入漂移。 */
  return [
    {
      transactionType: 'task_payment',
      amountMinor: signedAmountForTransaction('task_payment', Number(settlement.total_amount_minor)),
      currency: settlement.currency,
    },
    {
      transactionType: 'platform_fee',
      amountMinor: signedAmountForTransaction('platform_fee', Number(settlement.platform_amount_minor)),
      currency: settlement.currency,
    },
    {
      transactionType: 'persona_reserve',
      amountMinor: signedAmountForTransaction('persona_reserve', Number(settlement.persona_amount_minor)),
      currency: settlement.currency,
    },
  ];
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
  if (actual.length !== 3) return false;

  const actualCounts = countLedgerEntries(actual.map((row) => ({
    transactionType: row.transaction_type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
  })));
  const expectedCounts = countLedgerEntries(buildExpectedLedger(settlement));

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

      this.tx.transaction(() => {
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
      });

      repairedSettlements += 1;
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
